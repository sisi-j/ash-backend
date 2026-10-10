import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import settingsExample from "../contract/settings.json";
import { KEYS_MAX } from "../src/settings";
import { expectShape } from "./contract";
import { harness, JEB, NOTCH, reset } from "./harness";

let h: ReturnType<typeof harness>;
let token: string;

beforeEach(async () => {
  h = harness();
  await reset();
  token = (await h.signIn(NOTCH)).body.session.token;
});

type Change = { key: string; value: string; deleted: boolean; updated_at: number };
const change = (key: string, value: string, updated_at: number, deleted = false): Change => ({
  key,
  value,
  deleted,
  updated_at,
});

const put = (changes: Change[], as = token) => h.call("PUT", "/v1/settings", { token: as, body: { changes } });
const get = (as = token) => h.call("GET", "/v1/settings", { token: as });
const valueOf = (body: { settings: Change[] }, key: string) => body.settings.find((s) => s.key === key);

describe("synced settings", () => {
  it("start empty, and answer with the whole map, matching the contract", async () => {
    expect((await get()).body).toEqual({ settings: [] });

    const t = h.deps.now() - 1000;
    const after = await put([
      change("feature:crosshair.colour", "#FF2FBF71", t),
      change("instance:6c1e4b1a-2f7d-4a0e-9d3b-8f5a1c2e7b90", '{"name":"1.8.9 PvP"}', t),
    ]);

    expect(after.status).toBe(200);
    expectShape(after.body, settingsExample);
    expect((await get()).body).toEqual(after.body);
  });

  it("keep the latest change per key, so an older one never undoes a newer one", async () => {
    const t = h.deps.now() - 10_000;
    await put([change("feature:crosshair.size", "6", t + 500), change("launcher:launch_sounds", "true", t)]);

    // Another machine, behind on one key and ahead on the other.
    const after = await put([change("feature:crosshair.size", "3", t + 100), change("launcher:launch_sounds", "false", t + 900)]);

    expect(valueOf(after.body, "feature:crosshair.size")).toMatchObject({ value: "6", updated_at: t + 500 });
    expect(valueOf(after.body, "launcher:launch_sounds")).toMatchObject({ value: "false", updated_at: t + 900 });
  });

  it("ignore a change at the same time as the stored one, so replaying a sync changes nothing", async () => {
    const t = h.deps.now() - 1000;
    await put([change("feature:crosshair.size", "6", t)]);
    const after = await put([change("feature:crosshair.size", "9", t)]);
    expect(valueOf(after.body, "feature:crosshair.size")?.value).toBe("6");
  });

  it("clamp a time from a clock that runs fast to now, so it can't win every later change", async () => {
    const now = h.deps.now();
    await put([change("feature:crosshair.size", "6", now + 365 * 24 * 3600 * 1000)]);
    h.deps.advance(1000);

    const after = await put([change("feature:crosshair.size", "2", h.deps.now())]);

    expect(valueOf(after.body, "feature:crosshair.size")).toMatchObject({ value: "2", updated_at: now + 1000 });
  });

  it("record a deletion as a deleted key with no value, which a newer change can undo", async () => {
    const t = h.deps.now() - 5000;
    const key = "instance:6c1e4b1a-2f7d-4a0e-9d3b-8f5a1c2e7b90";
    await put([change(key, '{"name":"x"}', t)]);

    const deleted = await put([change(key, "ignored", t + 1, true)]);
    expect(valueOf(deleted.body, key)).toEqual({ key, value: "", deleted: true, updated_at: t + 1 });

    const back = await put([change(key, '{"name":"y"}', t + 2)]);
    expect(valueOf(back.body, key)).toMatchObject({ value: '{"name":"y"}', deleted: false });
  });

  it("are each account's own", async () => {
    const jeb = (await h.signIn(JEB)).body.session.token;
    await put([change("feature:crosshair.size", "6", h.deps.now() - 1)]);

    expect((await get(jeb)).body.settings).toEqual([]);
  });

  it("need a session", async () => {
    expect((await h.call("GET", "/v1/settings")).status).toBe(401);
    expect((await h.call("PUT", "/v1/settings", { body: { changes: [] } })).status).toBe(401);
  });

  it.each([
    [{ key: "machine:memory", value: "4096", deleted: false, updated_at: 1 }],
    [{ key: "feature:x", value: 6, deleted: false, updated_at: 1 }],
    [{ key: "feature:x", value: "6", updated_at: 1 }],
    [{ key: "feature:x", value: "6", deleted: false, updated_at: -1 }],
    [{ key: "feature:x", value: "x".repeat(64 * 1024 + 1), deleted: false, updated_at: 1 }],
    [{ key: "feature:has space", value: "6", deleted: false, updated_at: 1 }],
  ])("refuse a malformed change, and keep nothing from it: %#", async (bad) => {
    const response = await h.call("PUT", "/v1/settings", {
      token,
      body: { changes: [change("feature:fine", "1", 1), bad] },
    });
    expect(response.status).toBe(400);
    expect((await get()).body.settings).toEqual([]);
  });

  it(`hold up to ${KEYS_MAX} keys per account`, async () => {
    const t = h.deps.now() - 1;
    for (let start = 0; start < KEYS_MAX; start += 200) {
      const batch = Array.from({ length: Math.min(200, KEYS_MAX - start) }, (_, i) => change(`feature:k${start + i}`, "1", t));
      expect((await put(batch)).status).toBe(200);
    }
    expect((await put([change("feature:one-more", "1", t)])).status).toBe(413);
    // Changing a key it already has is still fine.
    expect((await put([change("feature:k0", "2", t + 1)])).status).toBe(200);
  });

  it("go with the account when it's deleted", async () => {
    await put([change("feature:crosshair.size", "6", h.deps.now() - 1)]);
    await h.call("DELETE", "/v1/account", { token });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});
