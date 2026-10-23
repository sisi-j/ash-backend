import { createRemoteJWKSet } from "jose";
import type { AccessKeys } from "./access";
import mojangKeys from "./mojang-keys.json";
import { importMojangKeys } from "./player-certificate";

/**
 * Everything the service reaches outside itself for, other than its own
 * bindings. Tests pass their own; the deployed Worker uses `realDeps`.
 */
export interface Deps {
  /** The keys Mojang certifies players' keys with (src/player-certificate.ts). */
  mojangKeys(): Promise<CryptoKey[]>;
  now(): number;
  randomBytes(n: number): Uint8Array;
  /** The keys a Cloudflare Access team signs with (src/access.ts). */
  accessKeys: AccessKeys;
}

// One key set per team per isolate: jose caches and refreshes the keys it
// fetched, so keeping the set is what keeps that cache.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Imported once per isolate. Bundled, not fetched: Mojang's firewall refuses
// a Worker's requests (ADR-0020, amended).
let mojang: Promise<CryptoKey[]> | undefined;

export function realDeps(): Deps {
  return {
    mojangKeys: () => (mojang ??= importMojangKeys(mojangKeys.playerCertificateKeys)),
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    accessKeys: (team) => {
      let set = keySets.get(team);
      if (set === undefined) {
        set = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
        keySets.set(team, set);
      }
      return set;
    },
  };
}
