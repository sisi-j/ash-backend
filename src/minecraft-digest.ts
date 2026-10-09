/**
 * Minecraft's digest: SHA-1, read as one signed big-endian number, printed
 * in lowercase hex without leading zeros, with a minus sign when negative.
 * The same function as ash-core's `session_server.rs`, which checks the same
 * published examples.
 */
export async function minecraftDigest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
  const negative = (bytes[0]! & 0x80) !== 0;
  if (negative) {
    // Two's complement: invert every bit, then add one.
    let carry = 1;
    for (let i = bytes.length - 1; i >= 0; i--) {
      const sum = (~bytes[i]! & 0xff) + carry;
      bytes[i] = sum & 0xff;
      carry = sum >> 8;
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const digits = hex.replace(/^0+/, "") || "0";
  return negative ? `-${digits}` : digits;
}

/** What every ash server id is the digest of, before the challenge (ADR-0020). */
const PREFIX = "ash-account-sign-in:";

/**
 * The server id a player joined for `challenge`. The player's machine derives
 * it the same way; this service never hands a server id over, so it can never
 * have a player join a real server's login hash.
 */
export function serverIdFor(challenge: string): Promise<string> {
  return minecraftDigest(PREFIX + challenge);
}
