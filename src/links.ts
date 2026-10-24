import type { Deps } from "./deps";
import { failure, json } from "./respond";

/**
 * Links the launcher shows that can change without a release (spec 0005 in
 * sisi-j/ash): the Discord invite behind "Send feedback". Absent until set,
 * and then the launcher shows no link rather than a dead one.
 */

/** Discord invites only: the link opens in the player's browser, so nothing else may be set. */
const INVITE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,64}$/;

async function current(env: Env): Promise<{ feedback_url: string | null }> {
  const row = await env.DB.prepare("SELECT url FROM links WHERE name = 'feedback'").first<{ url: string }>();
  return { feedback_url: row?.url ?? null };
}

/** GET /v1/links: public, and cached briefly, since it changes rarely. */
export async function publicLinks(env: Env): Promise<Response> {
  return json(await current(env), 200, { "cache-control": "public, max-age=300" });
}

/** GET /admin/api/links */
export async function adminLinks(env: Env): Promise<Response> {
  return json(await current(env));
}

/** PUT /admin/api/links, `{feedback_url}`: a Discord invite, or null to take it down. */
export async function setLinks(request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { feedback_url?: unknown } | null;
  const url = body?.feedback_url;
  if (url === null) {
    await env.DB.prepare("DELETE FROM links WHERE name = 'feedback'").run();
  } else if (typeof url === "string" && INVITE.test(url.trim())) {
    await env.DB.prepare(
      `INSERT INTO links (name, url, updated_at) VALUES ('feedback', ?1, ?2)
       ON CONFLICT (name) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
    )
      .bind(url.trim(), deps.now())
      .run();
  } else {
    return failure(400, "invalid_request", "expected {feedback_url}: a https://discord.gg/... or https://discord.com/invite/... link, or null");
  }
  return json(await current(env));
}
