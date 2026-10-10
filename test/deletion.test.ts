import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { expireStaleAccounts, STALE_AFTER_MS } from "../src/deletion";
import { harness, JEB, NOTCH, reset, tables } from "./harness";

let h: ReturnType<typeof harness>;

beforeEach(async () => {
  h = harness();
  await reset();
  // A catalogue, so a signed-in account has entitlement rows to delete too.
  await env.DB.prepare("INSERT INTO cosmetics (id, slot, name) VALUES ('cape.placeholder', 'cape', 'Placeholder')").run();
});

/** Every table with a `uuid` column, and how many of its rows are this account's. */
async function rowsAbout(uuid: string): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const table of await tables()) {
    const columns = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>();
    if (!columns.results.some((c) => c.name === "uuid")) continue;
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE uuid = ?`).bind(uuid).first<{ n: number }>();
    found[table] = row!.n;
  }
  return found;
}

describe("the schema", () => {
  it("has every account-keyed table cascade from accounts, so one delete removes it all", async () => {
    const checked: string[] = [];
    for (const table of await tables()) {
      if (table === "accounts") continue;
      const columns = await env.DB.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>();
      if (!columns.results.some((c) => c.name === "uuid")) continue;
      const keys = await env.DB.prepare(`SELECT "table", "from", on_delete FROM pragma_foreign_key_list(?)`)
        .bind(table)
        .all<{ table: string; from: string; on_delete: string }>();
      expect(keys.results, `${table}.uuid references accounts(uuid) ON DELETE CASCADE`).toContainEqual({
        table: "accounts",
        from: "uuid",
        on_delete: "CASCADE",
      });
      checked.push(table);
    }
    // Guards the loop above against finding nothing to check.
    expect(checked).toEqual(expect.arrayContaining(["sessions", "entitlements"]));
  });
});

describe("deleting an ash account", () => {
  it("leaves no row about it in any table", async () => {
    const { body } = await h.signIn(NOTCH);
    const before = await rowsAbout(NOTCH.uuid);
    // Guards against a vacuous pass: there was something to delete.
    expect(before).toMatchObject({ accounts: 1, sessions: 1, entitlements: 1 });

    const deleted = await h.call("DELETE", "/v1/account", { token: body.session.token });

    expect(deleted.status).toBe(204);
    const after = await rowsAbout(NOTCH.uuid);
    expect(Object.values(after).every((n) => n === 0), JSON.stringify(after)).toBe(true);
  });

  it("deletes only that account", async () => {
    const notch = (await h.signIn(NOTCH)).body.session.token;
    await h.signIn(JEB);

    await h.call("DELETE", "/v1/account", { token: notch });

    expect(await rowsAbout(JEB.uuid)).toMatchObject({ accounts: 1, sessions: 1, entitlements: 1 });
  });

  it("ends every session it had", async () => {
    const one = (await h.signIn()).body.session.token;
    const other = (await h.signIn()).body.session.token;

    await h.call("DELETE", "/v1/account", { token: one });

    expect((await h.call("GET", "/v1/account", { token: other })).body.error.kind).toBe("not_signed_in");
  });

  it("needs a session, and a fresh sign-in afterwards makes a new, empty account", async () => {
    expect((await h.call("DELETE", "/v1/account")).status).toBe(401);

    const token = (await h.signIn()).body.session.token;
    await h.call("DELETE", "/v1/account", { token });
    const again = await h.signIn();

    expect(again.body.account.created).toBe(true);
  });
});

describe("the 12-month expiry", () => {
  it("deletes exactly the accounts with no sign-in for over a year", async () => {
    const start = h.deps.now();
    await h.signIn(NOTCH);
    // jeb_ signs in two days later, so is a day short of a year at the check.
    h.deps.advance(2 * 24 * 60 * 60 * 1000);
    await h.signIn(JEB);

    const checkAt = start + STALE_AFTER_MS + 24 * 60 * 60 * 1000;
    const deleted = await expireStaleAccounts(env, checkAt);

    expect(deleted).toBe(1);
    expect(Object.values(await rowsAbout(NOTCH.uuid)).every((n) => n === 0)).toBe(true);
    expect(await rowsAbout(JEB.uuid)).toMatchObject({ accounts: 1, sessions: 1 });
  });

  it("is what the daily cron runs, at the cron's own time", async () => {
    await h.signIn(NOTCH);
    const controller = createScheduledController({ scheduledTime: h.deps.now() + STALE_AFTER_MS + 1, cron: "17 4 * * *" });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await rowsAbout(NOTCH.uuid)).accounts).toBe(0);
  });
});
