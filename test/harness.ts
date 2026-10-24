import { env } from "cloudflare:workers";
import { expect } from "vitest";
import challengeExample from "../contract/session-challenge.json";
import { handle } from "../src/app";
import { expectShape } from "./contract";
import { FakeMojang, fakeDeps } from "./fakes";

export const NOTCH = { uuid: "986dec87b7ec47ff89ff033fdb95c4b5", username: "Notch" };
export const JEB = { uuid: "853c80ef3c3749fdaa49938b674adae6", username: "jeb_" };

/** A player key's lifetime, as Mojang gives them: two days. */
export const KEY_LIFETIME_MS = 48 * 60 * 60 * 1000;

/** The application with a fake Mojang and a clock the test moves, over the
 *  real local D1. Storage is per test file, so `reset` empties it per test. */
export function harness() {
  const deps = fakeDeps();

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

  /** What the player's machine sends: its key, Mojang's certificate for it, and the challenge signed. */
  async function proofFor(
    profile: typeof NOTCH,
    challenge: string,
    opts: { by?: FakeMojang; expiresAt?: number } = {},
  ) {
    const mojang = opts.by ?? (await FakeMojang.trusted());
    const key = await mojang.certify(profile.uuid, opts.expiresAt ?? deps.now() + KEY_LIFETIME_MS);
    return {
      challenge,
      uuid: profile.uuid,
      username: profile.username,
      certificate: key.certificate,
      signature: await key.sign(challenge),
    };
  }

  async function signIn(profile = NOTCH) {
    const challenge = await newChallenge();
    return call("POST", "/v1/session", { body: await proofFor(profile, challenge) });
  }

  return { deps, call, newChallenge, proofFor, signIn };
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
  const order = ["equipped", "settings", "sessions", "entitlements", "redeemed_challenges", "cosmetics", "accounts", "posts", "links"];
  const all = await tables();
  const rest = all.filter((t) => !order.includes(t));
  await env.DB.batch([...rest, ...order].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

export async function rows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}
