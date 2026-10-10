import { createRemoteJWKSet } from "jose";
import type { AccessKeys } from "./access";
import { createMojang, type Mojang } from "./mojang";

/**
 * Everything the service reaches outside itself for, other than its own
 * bindings. Tests pass their own; the deployed Worker uses `realDeps`.
 */
export interface Deps {
  mojang: Mojang;
  now(): number;
  randomBytes(n: number): Uint8Array;
  /** The keys a Cloudflare Access team signs with (src/access.ts). */
  accessKeys: AccessKeys;
}

// One key set per team per isolate: jose caches and refreshes the keys it
// fetched, so keeping the set is what keeps that cache.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function realDeps(): Deps {
  return {
    mojang: createMojang((input, init) => fetch(input, init)),
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
