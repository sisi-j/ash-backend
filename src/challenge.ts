/**
 * Sign-in challenges are signed rather than stored: `<expiry>.<nonce>.<mac>`,
 * where the mac is an HMAC-SHA-256 of the first two parts under
 * CHALLENGE_SECRET. Issuing one writes nothing, so asking for challenges
 * cannot use up D1's daily writes; one is recorded only once redeemed.
 */

/** How long a challenge can be redeemed for. The player's machine joins and
 *  comes straight back, so this is generous. Research 0010 §1's live check
 *  says how long Mojang keeps a join confirmable; this must stay below it. */
export const CHALLENGE_LIFETIME_MS = 30_000;

export interface IssuedChallenge {
  challenge: string;
  expiresAt: number;
}

export async function issueChallenge(
  secret: string,
  now: number,
  randomBytes: (n: number) => Uint8Array,
): Promise<IssuedChallenge> {
  const expiresAt = now + CHALLENGE_LIFETIME_MS;
  const payload = `${expiresAt.toString(36)}.${hex(randomBytes(16))}`;
  return { challenge: `${payload}.${await mac(secret, payload)}`, expiresAt };
}

export type ChallengeCheck =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "malformed" | "forged" | "expired" };

export async function checkChallenge(secret: string, challenge: string, now: number): Promise<ChallengeCheck> {
  const parts = challenge.split(".");
  if (parts.length !== 3 || !/^[0-9a-z]{1,12}$/.test(parts[0]!) || !/^[0-9a-f]{32}$/.test(parts[1]!)) {
    return { ok: false, reason: "malformed" };
  }
  const payload = `${parts[0]}.${parts[1]}`;
  if (!timingSafeEqual(parts[2]!, await mac(secret, payload))) {
    return { ok: false, reason: "forged" };
  }
  const expiresAt = parseInt(parts[0]!, 36);
  if (now > expiresAt) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, expiresAt };
}

async function mac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64url(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
