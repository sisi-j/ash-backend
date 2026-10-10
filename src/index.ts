import { handle } from "./app";
import { expireStaleAccounts } from "./deletion";
import { realDeps } from "./deps";

export default {
  fetch(request, env): Promise<Response> {
    return handle(request, env, realDeps());
  },

  /** The daily cron in wrangler.jsonc: the 12-month expiry (spec 0004). */
  async scheduled(controller, env, _ctx): Promise<void> {
    const deleted = await expireStaleAccounts(env, controller.scheduledTime);
    console.log(`expired ${deleted} account(s) with no sign-in for a year`);
  },
} satisfies ExportedHandler<Env>;
