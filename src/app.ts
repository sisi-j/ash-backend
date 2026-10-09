import type { Deps } from "./deps";
import { failure, json } from "./respond";
import { account, authenticate, challenge, signIn, type SignedIn, signOut } from "./session";

type Handler = (request: Request, env: Env, deps: Deps) => Promise<Response>;

/** A route that needs a signed-in account gets it, or the request gets 401. */
function signedIn(
  handler: (who: SignedIn, request: Request, env: Env, deps: Deps) => Response | Promise<Response>,
): Handler {
  return async (request, env, deps) => {
    const who = await authenticate(request, env, deps);
    return who instanceof Response ? who : handler(who, request, env, deps);
  };
}

const routes: Record<string, Partial<Record<string, Handler>>> = {
  "/health": { GET: (_request, env) => health(env) },
  "/v1/session/challenge": { POST: (_request, env, deps) => challenge(env, deps) },
  "/v1/session": {
    POST: signIn,
    DELETE: signedIn((who, _request, env) => signOut(who, env)),
  },
  "/v1/account": { GET: signedIn((who) => account(who)) },
};

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const methods = routes[url.pathname];
  if (methods === undefined) {
    return failure(404, "not_found", `nothing at ${url.pathname}`);
  }
  const handler = methods[request.method];
  if (handler === undefined) {
    return failure(405, "method_not_allowed", `${request.method} is not allowed on ${url.pathname}`);
  }
  return handler(request, env, deps);
}

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
