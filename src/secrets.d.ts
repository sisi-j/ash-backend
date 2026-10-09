// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Set with `wrangler secret put <NAME> --env <env>`; locally in .dev.vars;
// in tests as a Miniflare binding in vitest.config.ts. Declared on both the
// global Env and Cloudflare.Env, which `cloudflare:workers`'s `env` uses.
interface Secrets {
  /** Signs sign-in challenges (src/challenge.ts). Rotating it only
   *  invalidates challenges issued in the last 30 seconds. */
  CHALLENGE_SECRET: string;
}

interface Env extends Secrets {}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}
