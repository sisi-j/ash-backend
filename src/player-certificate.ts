/**
 * How a player proves who they are to ash (ADR-0020, amended 2026-10-23):
 * with the key Mojang gives every player for signed chat, rather than by
 * asking Mojang. Mojang's firewall refuses requests from Cloudflare, so a
 * Worker can't ask; it doesn't need to.
 *
 * Mojang certifies a player's public key by signing, with SHA1withRSA, the
 * player's UUID (16 bytes), the key's expiry (8 bytes, milliseconds) and the
 * key itself (X.509) - the bytes `ProfilePublicKey.Data.signedPayload` in the
 * game builds, checked in its bytecode. The player then signs ash's
 * challenge with the matching private key, SHA256withRSA, as the game signs
 * chat. Both checks run here, offline, against Mojang's published keys.
 */

/** What the player signs: this, then the challenge, as UTF-8. Never a message the game would sign. */
export const SIGNED_PREFIX = "ash-account-sign-in:";

/** Mojang's player-certificate keys, ready to verify with. */
export async function importMojangKeys(spkiBase64: string[]): Promise<CryptoKey[]> {
  return Promise.all(
    spkiBase64.map((key) =>
      crypto.subtle.importKey(
        "spki",
        fromBase64(key) ?? new Uint8Array(),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
        false,
        ["verify"],
      ),
    ),
  );
}

/** The bytes Mojang signs to certify `publicKey` as `uuid`'s until `expiresAt`. */
export function certifiedBytes(uuid: string, expiresAt: number, publicKey: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(24 + publicKey.length);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(uuid.slice(2 * i, 2 * i + 2), 16);
  new DataView(bytes.buffer).setBigInt64(16, BigInt(expiresAt));
  bytes.set(publicKey, 24);
  return bytes;
}

/** Whether one of Mojang's keys certified `publicKey` as `uuid`'s until `expiresAt`. */
export async function certifiedByMojang(
  mojangKeys: CryptoKey[],
  uuid: string,
  expiresAt: number,
  publicKey: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const data = certifiedBytes(uuid, expiresAt, publicKey);
  for (const key of mojangKeys) {
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)) return true;
  }
  return false;
}

/** Whether `signature` is `publicKey`'s, over ash's challenge. */
export async function signedByPlayer(publicKey: Uint8Array, signature: Uint8Array, challenge: string): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", publicKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
  } catch {
    return false;
  }
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(SIGNED_PREFIX + challenge));
}

/** Standard base64, or null if it isn't. */
export function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
