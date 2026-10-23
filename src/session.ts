import { base64url, checkChallenge, hex, issueChallenge } from "./challenge";
import type { Deps } from "./deps";
import { serverIdFor } from "./minecraft-digest";
import { MojangUnavailable } from "./mojang";
import { failure, json } from "./respond";

/** How long an ash session lasts. The launcher runs the handshake again
 *  after every Microsoft sign-in and refresh, so most are replaced sooner. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const USERNAME = /^[A-Za-z0-9_]{1,16}$/;

/** POST /v1/session/challenge */
export async function challenge(env: Env, deps: Deps): Promise<Response> {
  const issued = await issueChallenge(env.CHALLENGE_SECRET, deps.now(), deps.randomBytes);
  return json({ challenge: issued.challenge, expires_at: issued.expiresAt });
}

/**
 * POST /v1/session, `{challenge, username}`: the backend's half of the join
 * handshake (ADR-0020). The account is whoever Mojang says joined, never
 * whoever the caller claims to be.
 */
export async function signIn(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { challenge?: unknown; username?: unknown } | null;
  if (typeof body?.challenge !== "string" || typeof body.username !== "string" || !USERNAME.test(body.username)) {
    return failure(400, "invalid_request", "expected {challenge, username}");
  }
  const now = deps.now();

  const check = await checkChallenge(env.CHALLENGE_SECRET, body.challenge, now);
  if (!check.ok) {
    return failure(400, "challenge_invalid", `the challenge is ${check.reason}; ask for a new one`);
  }

  let profile;
  try {
    profile = await deps.mojang.hasJoined(body.username, await serverIdFor(body.challenge));
  } catch (e) {
    if (e instanceof MojangUnavailable) {
      // What Mojang actually said, in the log and in the answer, so a failure
      // here can be told apart from a slow one without guessing.
      console.warn(`mojang unavailable: ${e.message}`);
      return failure(
        503,
        "mojang_unavailable",
        `Mojang's session server could not confirm the join (${e.message}); try again`,
      );
    }
    throw e;
  }
  if (profile === null) {
    return failure(401, "not_joined", "Mojang says that player did not join this challenge");
  }

  // Claimed only now, after Mojang confirmed a real join, so a redemption
  // never costs a write unless a real player is signing in.
  const claim = await env.DB.prepare(
    "INSERT INTO redeemed_challenges (challenge, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(body.challenge, check.expiresAt)
    .run();
  if (claim.meta.changes === 0) {
    return failure(409, "challenge_used", "that challenge was already redeemed; ask for a new one");
  }

  const existing = await env.DB.prepare("SELECT 1 FROM accounts WHERE uuid = ?").bind(profile.uuid).first();
  const token = base64url(deps.randomBytes(32));
  const expiresAt = now + SESSION_LIFETIME_MS;

  await env.DB.batch([
    env.DB.prepare("DELETE FROM redeemed_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare(
      `INSERT INTO accounts (uuid, username, created_at, last_sign_in_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (uuid) DO UPDATE SET username = excluded.username, last_sign_in_at = excluded.last_sign_in_at`,
    ).bind(profile.uuid, profile.username, now),
    // Phase 4 grants every account the whole catalogue (ADR-0010, amended).
    env.DB.prepare(
      "INSERT OR IGNORE INTO entitlements (uuid, cosmetic_id, granted_at) SELECT ?, id, ? FROM cosmetics",
    ).bind(profile.uuid, now),
    env.DB.prepare("DELETE FROM sessions WHERE uuid = ? AND expires_at <= ?").bind(profile.uuid, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, uuid, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await sha256(token),
      profile.uuid,
      now,
      expiresAt,
    ),
  ]);

  return json({
    session: { token, expires_at: expiresAt },
    account: { uuid: profile.uuid, username: profile.username, created: existing === null },
  });
}

export interface SignedIn {
  uuid: string;
  username: string;
  tokenHash: string;
}

/** The account a request's bearer token belongs to, or the 401 to answer. */
export async function authenticate(request: Request, env: Env, deps: Deps): Promise<SignedIn | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header)?.[1];
  if (token === undefined) {
    return failure(401, "not_signed_in", "expected an ash session token");
  }
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT a.uuid, a.username FROM sessions s JOIN accounts a ON a.uuid = s.uuid
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  )
    .bind(tokenHash, deps.now())
    .first<{ uuid: string; username: string }>();
  if (row === null) {
    return failure(401, "not_signed_in", "that session has ended; sign in again");
  }
  return { uuid: row.uuid, username: row.username, tokenHash };
}

/** GET /v1/account */
export function account(who: SignedIn): Response {
  return json({ account: { uuid: who.uuid, username: who.username } });
}

/** DELETE /v1/session: ends this session only. */
export async function signOut(who: SignedIn, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(who.tokenHash).run();
  return new Response(null, { status: 204 });
}

async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
