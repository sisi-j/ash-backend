import { base64url, checkChallenge, hex, issueChallenge } from "./challenge";
import type { Deps } from "./deps";
import { certifiedByMojang, fromBase64, signedByPlayer } from "./player-certificate";
import { failure, json } from "./respond";

/** How long an ash session lasts. The launcher runs the handshake again
 *  after every Microsoft sign-in and refresh, so most are replaced sooner. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const USERNAME = /^[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{32}$/;
/** Far beyond any RSA key or signature Mojang hands out. */
const MAX_KEY_BYTES = 2048;

interface SignInBody {
  challenge: string;
  uuid: string;
  username: string;
  certificate: { public_key: Uint8Array; expires_at: number; signature: Uint8Array };
  signature: Uint8Array;
}

/** `{challenge, uuid, username, certificate: {public_key, expires_at, signature}, signature}`, or null. */
function readSignIn(raw: unknown): SignInBody | null {
  const body = raw as Record<string, unknown> | null;
  const certificate = body?.certificate as Record<string, unknown> | null | undefined;
  const bytes = (value: unknown) => {
    const decoded = typeof value === "string" ? fromBase64(value) : null;
    return decoded !== null && decoded.length > 0 && decoded.length <= MAX_KEY_BYTES ? decoded : null;
  };
  const publicKey = bytes(certificate?.public_key);
  const keySignature = bytes(certificate?.signature);
  const signature = bytes(body?.signature);
  if (
    typeof body?.challenge !== "string" ||
    typeof body.uuid !== "string" ||
    !UUID.test(body.uuid) ||
    typeof body.username !== "string" ||
    !USERNAME.test(body.username) ||
    typeof certificate?.expires_at !== "number" ||
    !Number.isSafeInteger(certificate.expires_at) ||
    publicKey === null ||
    keySignature === null ||
    signature === null
  ) {
    return null;
  }
  return {
    challenge: body.challenge,
    uuid: body.uuid,
    username: body.username,
    certificate: { public_key: publicKey, expires_at: certificate.expires_at, signature: keySignature },
    signature,
  };
}

/** POST /v1/session/challenge */
export async function challenge(env: Env, deps: Deps): Promise<Response> {
  const issued = await issueChallenge(env.CHALLENGE_SECRET, deps.now(), deps.randomBytes);
  return json({ challenge: issued.challenge, expires_at: issued.expiresAt });
}

/**
 * POST /v1/session: the backend's half of the sign-in (ADR-0020, amended).
 * The account is the UUID Mojang certified the player's key for, and only
 * the holder of that key's private half can sign the challenge. Nothing is
 * asked of Mojang; the username is the player's word, kept for display.
 */
export async function signIn(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = readSignIn(await request.json().catch(() => null));
  if (body === null) {
    return failure(
      400,
      "invalid_request",
      "expected {challenge, uuid, username, certificate: {public_key, expires_at, signature}, signature}",
    );
  }
  const now = deps.now();

  const check = await checkChallenge(env.CHALLENGE_SECRET, body.challenge, now);
  if (!check.ok) {
    return failure(400, "challenge_invalid", `the challenge is ${check.reason}; ask for a new one`);
  }

  const { certificate } = body;
  if (certificate.expires_at <= now) {
    return failure(401, "certificate_expired", "that player key has expired; get a new one from Mojang");
  }
  const certified = await certifiedByMojang(
    await deps.mojangKeys(),
    body.uuid,
    certificate.expires_at,
    certificate.public_key,
    certificate.signature,
  );
  if (!certified) {
    return failure(401, "certificate_invalid", "Mojang did not certify that key for that player");
  }
  if (!(await signedByPlayer(certificate.public_key, body.signature, body.challenge))) {
    return failure(401, "signature_invalid", "the challenge was not signed with that player's key");
  }
  const profile = { uuid: body.uuid, username: body.username };

  // Claimed only now, after the proof checked out, so a redemption never
  // costs a write unless a real player is signing in.
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
