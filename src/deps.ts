import { createMojang, type Mojang } from "./mojang";

/**
 * Everything the service reaches outside itself for, other than its own
 * bindings. Tests pass their own; the deployed Worker uses `realDeps`.
 */
export interface Deps {
  mojang: Mojang;
  now(): number;
  randomBytes(n: number): Uint8Array;
}

export function realDeps(): Deps {
  return {
    mojang: createMojang((input, init) => fetch(input, init)),
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
}
