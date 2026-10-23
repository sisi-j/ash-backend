import type { Deps } from "../src/deps";
import { certifiedBytes, SIGNED_PREFIX, toBase64 } from "../src/player-certificate";
import { accessKeys } from "./access-keys";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };

/** A player's key, as Mojang's /player/certificates hands it out, and what it signs. */
export interface PlayerKey {
  certificate: { public_key: string; expires_at: number; signature: string };
  sign(challenge: string): Promise<string>;
}

// Making RSA keys is slow, so each player's is made once per test file.
const playerKeys = new Map<string, Promise<CryptoKeyPair>>();

/**
 * Mojang, as far as signing in to ash goes: it certifies players' keys, the
 * way the real one signs every player's chat key. `trusted()` is the one the
 * fake deps hold the public key of; any other is a stand-in nobody trusts.
 */
export class FakeMojang {
  private static trustedOne: Promise<FakeMojang> | undefined;

  private constructor(private readonly key: CryptoKeyPair) {}

  static async create(): Promise<FakeMojang> {
    const key = (await crypto.subtle.generateKey({ ...RSA, hash: "SHA-1" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return new FakeMojang(key);
  }

  static trusted(): Promise<FakeMojang> {
    return (FakeMojang.trustedOne ??= FakeMojang.create());
  }

  get publicKey(): CryptoKey {
    return this.key.publicKey;
  }

  /** `uuid`'s key, certified by this Mojang until `expiresAt`. */
  async certify(uuid: string, expiresAt: number): Promise<PlayerKey> {
    let pair = playerKeys.get(uuid);
    if (pair === undefined) {
      pair = crypto.subtle.generateKey({ ...RSA, hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
      playerKeys.set(uuid, pair);
    }
    const { privateKey, publicKey } = await pair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer);
    const certified = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", this.key.privateKey, certifiedBytes(uuid, expiresAt, spki));
    return {
      certificate: { public_key: toBase64(spki), expires_at: expiresAt, signature: toBase64(new Uint8Array(certified)) },
      async sign(challenge) {
        const message = new TextEncoder().encode(SIGNED_PREFIX + challenge);
        return toBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, message)));
      },
    };
  }
}

/** A clock the test moves, randomness that differs call to call, and the fake Mojang's key. */
export function fakeDeps(start = 1_760_000_000_000): Deps & { advance(ms: number): void } {
  let now = start;
  return {
    mojangKeys: async () => [(await FakeMojang.trusted()).publicKey],
    now: () => now,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    accessKeys,
    advance(ms) {
      now += ms;
    },
  };
}
