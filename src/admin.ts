import { verifyAccess } from "./access";
import { ADMIN_HTML, ADMIN_JS } from "./admin-page";
import type { Deps } from "./deps";
import { createPost, deleteCover, deletePost, listPosts, putCover, setPublished, updatePost } from "./news";
import { failure } from "./respond";

/**
 * Everything under /admin. Every request - the page, its script and its API -
 * is verified against Cloudflare Access first; nothing here is reachable
 * without it.
 */
export async function handleAdmin(request: Request, env: Env, deps: Deps): Promise<Response> {
  const who = await verifyAccess(request, env, deps.accessKeys);
  if (who instanceof Response) return who;

  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === "/admin" || pathname === "/admin/") {
    return method === "GET" ? page(ADMIN_HTML, "text/html", env) : notAllowed(method, pathname);
  }
  if (pathname === "/admin/app.js") {
    return method === "GET" ? page(ADMIN_JS, "text/javascript", env) : notAllowed(method, pathname);
  }
  if (pathname === "/admin/api/posts") {
    if (method === "GET") return listPosts(env);
    if (method === "POST") return createPost(request, env, deps);
    return notAllowed(method, pathname);
  }
  const m = /^\/admin\/api\/posts\/([0-9a-f-]{36})(\/publish|\/unpublish|\/cover)?$/.exec(pathname);
  if (m) {
    const id = m[1]!;
    switch (`${method} ${m[2] ?? ""}`) {
      case "PUT ":
        return updatePost(id, request, env, deps);
      case "DELETE ":
        return deletePost(id, env);
      case "POST /publish":
        return setPublished(id, true, env, deps);
      case "POST /unpublish":
        return setPublished(id, false, env, deps);
      case "PUT /cover":
        return putCover(id, request, env);
      case "DELETE /cover":
        return deleteCover(id, env);
    }
    return notAllowed(method, pathname);
  }
  return failure(404, "not_found", `nothing at ${pathname}`);
}

function page(body: string, type: string, env: Env): Response {
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "no-store",
      "content-security-policy": `default-src 'self'; img-src 'self' ${env.ASSETS_URL}; style-src 'unsafe-inline'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
    },
  });
}

const notAllowed = (method: string, pathname: string) =>
  failure(405, "method_not_allowed", `${method} is not allowed on ${pathname}`);
