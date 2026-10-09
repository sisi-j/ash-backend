import { failure, json } from "./respond";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return failure(405, "method_not_allowed", `${request.method} is not allowed on /health`);
      }
      return health(env);
    }

    return failure(404, "not_found", `nothing at ${url.pathname}`);
  },
} satisfies ExportedHandler<Env>;

/**
 * What is deployed, and whether its database answers. The deploy checks this
 * on staging after every merge (ash-backend#2), so "deployed" means "running".
 */
async function health(env: Env): Promise<Response> {
  let database: "ok" | "unreachable" = "ok";
  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    database = "unreachable";
  }
  return json({ commit: env.COMMIT, database }, database === "ok" ? 200 : 503);
}
