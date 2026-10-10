import { env } from "cloudflare:workers";
import { expect } from "vitest";
import challengeExample from "../contract/session-challenge.json";
import { handle } from "../src/app";
import { serverIdFor } from "../src/minecraft-digest";
import { expectShape } from "./contract";
import { FakeMojang, fakeDeps } from "./fakes";

export const NOTCH = { uuid: "986dec87b7ec47ff89ff033fdb95c4b5", username: "Notch" };
export const JEB = { uuid: "853c80ef3c3749fdaa49938b674adae6", username: "jeb_" };

/** The application with a fake Mojang and a clock the test moves, over the
 *  real local D1. Storage is per test file, so `reset` empties it per test. */
export function harness() {
  const mojang = new FakeMojang();
  const deps = fakeDeps(mojang);

  async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    const response = await handle(
      new Request(`https://api.test${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
      env,
      deps,
    );
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : (JSON.parse(text) as any) };
  }

  async function newChallenge(): Promise<string> {
    const { status, body } = await call("POST", "/v1/session/challenge");
    expect(status).toBe(200);
    expectShape(body, challengeExample);
    return body.challenge;
  }

  /** What the player's machine does: join the derived server id at Mojang. */
  async function joinAs(profile: typeof NOTCH, challenge: string) {
    mojang.join(profile, await serverIdFor(challenge));
  }

  async function signIn(profile = NOTCH) {
    const challenge = await newChallenge();
    await joinAs(profile, challenge);
    return call("POST", "/v1/session", { body: { challenge, username: profile.username } });
  }

  return { mojang, deps, call, newChallenge, joinAs, signIn };
}

/** Every table the migrations made, by name. */
export async function tables(): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`,
  ).all<{ name: string }>();
  return result.results.map((r) => r.name);
}

export async function reset(): Promise<void> {
  // Children before parents, so no foreign key stops a delete.
  const order = ["sessions", "entitlements", "redeemed_challenges", "cosmetics", "accounts"];
  const all = await tables();
  const rest = all.filter((t) => !order.includes(t));
  await env.DB.batch([...rest, ...order].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export async function rows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}
