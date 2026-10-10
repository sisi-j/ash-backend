import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import accountExample from "../contract/account.json";
import errorExample from "../contract/error.json";
import sessionExample from "../contract/session.json";
import { CHALLENGE_LIFETIME_MS } from "../src/challenge";
import { SESSION_LIFETIME_MS } from "../src/session";
import { expectShape } from "./contract";
import { harness, NOTCH, reset, rows } from "./harness";

let h: ReturnType<typeof harness>;
let mojang: ReturnType<typeof harness>["mojang"];
let deps: ReturnType<typeof harness>["deps"];
let call: ReturnType<typeof harness>["call"];
let newChallenge: ReturnType<typeof harness>["newChallenge"];
let joinAs: ReturnType<typeof harness>["joinAs"];
let signIn: ReturnType<typeof harness>["signIn"];

beforeEach(async () => {
  h = harness();
  ({ mojang, deps, call, newChallenge, joinAs, signIn } = h);
  await reset();
});

async function everyRow(): Promise<number> {
  let total = 0;
  for (const t of ["accounts", "sessions", "redeemed_challenges", "entitlements"]) total += await rows(t);
  return total;
}

describe("signing in", () => {
  it("creates the account Mojang confirmed, once, and says it was created", async () => {
    const first = await signIn();

    expect(first.status).toBe(200);
    expectShape(first.body, sessionExample);
    expect(first.body.account).toEqual({ ...NOTCH, created: true });

    const second = await signIn();
    expect(second.status).toBe(200);
    expect(second.body.account.created).toBe(false);
    expect(await rows("accounts")).toBe(1);
  });

  it("keys the account on the UUID Mojang returns, never on anything the caller sends", async () => {
    const challenge = await newChallenge();
    await joinAs(NOTCH, challenge);

    const { body } = await call("POST", "/v1/session", {
      body: { challenge, username: "Notch", uuid: "00000000000000000000000000000000" },
    });

    expect(body.account.uuid).toBe(NOTCH.uuid);
    const stored = await env.DB.prepare("SELECT uuid FROM accounts").all<{ uuid: string }>();
    expect(stored.results.map((r) => r.uuid)).toEqual([NOTCH.uuid]);
  });

  it("asks Mojang about the server id derived from the challenge, never the challenge itself", async () => {
    await signIn();

    expect(mojang.asked).toHaveLength(1);
    const [asked] = mojang.asked;
    expect(asked!.serverId).not.toContain(".");
    expect(asked!.serverId).toMatch(/^-?[0-9a-f]{1,40}$/);
  });

  it("updates the username when the player has renamed", async () => {
    await signIn();
    const renamed = await signIn({ ...NOTCH, username: "Notch2" });

    expect(renamed.body.account).toEqual({ uuid: NOTCH.uuid, username: "Notch2", created: false });
    expect(await rows("accounts")).toBe(1);
  });

  it("grants every account the whole catalogue, as real entitlement rows", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cosmetics (id, slot, name) VALUES ('cape.placeholder', 'cape', 'Placeholder cape')"),
      env.DB.prepare("INSERT INTO cosmetics (id, slot, name) VALUES ('emote.wave', 'emote', 'Wave')"),
    ]);

    await signIn();

    const granted = await env.DB.prepare("SELECT cosmetic_id FROM entitlements WHERE uuid = ? ORDER BY cosmetic_id")
      .bind(NOTCH.uuid)
      .all<{ cosmetic_id: string }>();
    expect(granted.results.map((r) => r.cosmetic_id)).toEqual(["cape.placeholder", "emote.wave"]);
  });
});

describe("a challenge", () => {
  it("can be redeemed once", async () => {
    const challenge = await newChallenge();
    await joinAs(NOTCH, challenge);
    const body = { challenge, username: "Notch" };

    expect((await call("POST", "/v1/session", { body })).status).toBe(200);
    const again = await call("POST", "/v1/session", { body });

    expect(again.status).toBe(409);
    expect(again.body.error.kind).toBe("challenge_used");
    expect(await rows("sessions")).toBe(1);
  });

  it("expires, and an expired one is refused before Mojang is asked", async () => {
    const challenge = await newChallenge();
    await joinAs(NOTCH, challenge);
    deps.advance(CHALLENGE_LIFETIME_MS + 1);

    const { status, body } = await call("POST", "/v1/session", { body: { challenge, username: "Notch" } });

    expect(status).toBe(400);
    expect(body.error.kind).toBe("challenge_invalid");
    expect(mojang.asked).toHaveLength(0);
  });

  it("that this service never issued is refused before Mojang is asked", async () => {
    const issued = await newChallenge();
    const [expiry, nonce, mac] = issued.split(".");
    const forged = `${expiry}.${nonce!.replace(/.$/, (c) => (c === "0" ? "1" : "0"))}.${mac}`;
    await joinAs(NOTCH, forged);

    const { status, body } = await call("POST", "/v1/session", { body: { challenge: forged, username: "Notch" } });

    expect(status).toBe(400);
    expect(body.error.kind).toBe("challenge_invalid");
    expectShape(body, errorExample);
    expect(mojang.asked).toHaveLength(0);
  });

  it("costs no database write to issue, however many are asked for", async () => {
    const before = await everyRow();
    for (let i = 0; i < 25; i++) await newChallenge();
    expect(await everyRow()).toBe(before);
  });

  it("is different every time", async () => {
    expect(await newChallenge()).not.toBe(await newChallenge());
  });
});

describe("a failed sign-in", () => {
  it("issues nothing when Mojang says the player did not join", async () => {
    const challenge = await newChallenge();
    // The player joined a different challenge - or nobody joined at all.
    await joinAs(NOTCH, await newChallenge());

    const { status, body } = await call("POST", "/v1/session", { body: { challenge, username: "Notch" } });

    expect(status).toBe(401);
    expect(body.error.kind).toBe("not_joined");
    expect(await everyRow()).toBe(0);
  });

  it("says Mojang is unavailable, not 'not signed in', when Mojang cannot answer", async () => {
    const challenge = await newChallenge();
    await joinAs(NOTCH, challenge);
    mojang.down = true;

    const { status, body } = await call("POST", "/v1/session", { body: { challenge, username: "Notch" } });

    expect(status).toBe(503);
    expect(body.error.kind).toBe("mojang_unavailable");
    expect(await everyRow()).toBe(0);
  });

  it.each([
    [{}],
    [{ challenge: "x" }],
    [{ challenge: "x", username: "not a name" }],
    [{ challenge: "x", username: "seventeen_letters" }],
  ])("refuses a malformed request %j", async (body) => {
    const response = await call("POST", "/v1/session", { body });
    expect(response.status).toBe(400);
    expect(response.body.error.kind).toBe("invalid_request");
  });
});

describe("a session", () => {
  it("signs its account in", async () => {
    const { body } = await signIn();

    const me = await call("GET", "/v1/account", { token: body.session.token });

    expect(me.status).toBe(200);
    expectShape(me.body, accountExample);
    expect(me.body.account).toEqual(NOTCH);
  });

  it("is stored only as a hash", async () => {
    const { body } = await signIn();

    const stored = await env.DB.prepare("SELECT * FROM sessions").all();
    expect(JSON.stringify(stored.results)).not.toContain(body.session.token);
  });

  it("ends when it expires", async () => {
    const { body } = await signIn();
    deps.advance(SESSION_LIFETIME_MS);

    const me = await call("GET", "/v1/account", { token: body.session.token });

    expect(me.status).toBe(401);
    expect(me.body.error.kind).toBe("not_signed_in");
  });

  it("ends when signed out, and only that session ends", async () => {
    const one = (await signIn()).body.session.token;
    const other = (await signIn()).body.session.token;

    expect((await call("DELETE", "/v1/session", { token: one })).status).toBe(204);

    expect((await call("GET", "/v1/account", { token: one })).status).toBe(401);
    expect((await call("GET", "/v1/account", { token: other })).status).toBe(200);
  });

  it("is required, and a made-up token is refused", async () => {
    expect((await call("GET", "/v1/account")).body.error.kind).toBe("not_signed_in");
    const madeUp = "A".repeat(43);
    expect((await call("GET", "/v1/account", { token: madeUp })).body.error.kind).toBe("not_signed_in");
  });
});
