import type { Deps } from "./deps";
import { failure, json } from "./respond";

/**
 * News posts (spec 0004, ash-backend#9): written on /admin, published to
 * GET /v1/news for the launcher's News page.
 */

const KINDS = ["news", "patch_notes"] as const;
type Kind = (typeof KINDS)[number];

export const PUBLISHED_LIMIT = 30;
export const TITLE_MAX = 120;
export const BODY_MAX = 20_000;
export const COVER_MAX_BYTES = 2 * 1024 * 1024;
const COVER_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

interface PostRow {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  cover: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

function coverUrl(env: Env, cover: string | null): string | null {
  return cover === null ? null : `${env.ASSETS_URL}/${cover}`;
}

/** What the launcher sees of a published post. */
function published(env: Env, row: PostRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    cover_url: coverUrl(env, row.cover),
    published_at: row.published_at,
    updated_at: row.updated_at,
  };
}

/** What the admin page sees of any post, drafts included. */
function forAdmin(env: Env, row: PostRow) {
  return { ...published(env, row), created_at: row.created_at };
}

/** GET /v1/news: published posts, newest first. Public, and cacheable. */
export async function publishedNews(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT * FROM posts WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT ?",
  )
    .bind(PUBLISHED_LIMIT)
    .all<PostRow>();
  return json(
    { posts: rows.results.map((row) => published(env, row)) },
    200,
    { "cache-control": "public, max-age=60" },
  );
}

// ---- /admin/api ------------------------------------------------------------

type Draft = { kind: Kind; title: string; body: string };

async function readDraft(request: Request): Promise<Draft | Response> {
  const body = (await request.json().catch(() => null)) as Partial<Record<keyof Draft, unknown>> | null;
  const kind = body?.kind;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const text = body?.body;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return failure(400, "invalid_request", "kind must be news or patch_notes");
  }
  if (title.length === 0 || title.length > TITLE_MAX) {
    return failure(400, "invalid_request", `a title is 1 to ${TITLE_MAX} characters`);
  }
  if (typeof text !== "string" || text.length > BODY_MAX) {
    return failure(400, "invalid_request", `a body is up to ${BODY_MAX} characters`);
  }
  return { kind: kind as Kind, title, body: text };
}

async function find(env: Env, id: string): Promise<PostRow | null> {
  return env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(id).first<PostRow>();
}

const notFound = (id: string) => failure(404, "not_found", `no post ${id}`);

export async function listPosts(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC").all<PostRow>();
  return json({ posts: rows.results.map((row) => forAdmin(env, row)) });
}

export async function createPost(request: Request, env: Env, deps: Deps): Promise<Response> {
  const draft = await readDraft(request);
  if (draft instanceof Response) return draft;
  const now = deps.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO posts (id, kind, title, body, cover, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)",
  )
    .bind(id, draft.kind, draft.title, draft.body, now, now)
    .run();
  return json({ post: forAdmin(env, (await find(env, id))!) }, 201);
}

export async function updatePost(id: string, request: Request, env: Env, deps: Deps): Promise<Response> {
  const draft = await readDraft(request);
  if (draft instanceof Response) return draft;
  const result = await env.DB.prepare("UPDATE posts SET kind = ?, title = ?, body = ?, updated_at = ? WHERE id = ?")
    .bind(draft.kind, draft.title, draft.body, deps.now(), id)
    .run();
  if (result.meta.changes === 0) return notFound(id);
  return json({ post: forAdmin(env, (await find(env, id))!) });
}

/** Publishing stamps the time it goes out; unpublishing makes it a draft again. */
export async function setPublished(id: string, publish: boolean, env: Env, deps: Deps): Promise<Response> {
  const result = await env.DB.prepare("UPDATE posts SET published_at = ?, updated_at = ? WHERE id = ?")
    .bind(publish ? deps.now() : null, deps.now(), id)
    .run();
  if (result.meta.changes === 0) return notFound(id);
  return json({ post: forAdmin(env, (await find(env, id))!) });
}

export async function deletePost(id: string, env: Env): Promise<Response> {
  const row = await find(env, id);
  if (row === null) return notFound(id);
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  if (row.cover !== null) await env.ASSETS.delete(row.cover);
  return new Response(null, { status: 204 });
}

/**
 * PUT /admin/api/posts/:id/cover with the image as the body. Each upload gets
 * a new key, so a cached old cover can never stand in for a new one, and the
 * old object is deleted.
 */
export async function putCover(id: string, request: Request, env: Env): Promise<Response> {
  const row = await find(env, id);
  if (row === null) return notFound(id);
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const ext = COVER_TYPES[type];
  if (ext === undefined) {
    return failure(415, "unsupported_image", "a cover is a PNG, JPEG or WebP image");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) {
    return failure(413, "image_too_large", "a cover is up to 2 MB");
  }
  const key = `news/${id}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await env.ASSETS.put(key, bytes, {
    httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
  });
  await env.DB.prepare("UPDATE posts SET cover = ? WHERE id = ?").bind(key, id).run();
  if (row.cover !== null) await env.ASSETS.delete(row.cover);
  return json({ post: forAdmin(env, (await find(env, id))!) });
}

export async function deleteCover(id: string, env: Env): Promise<Response> {
  const row = await find(env, id);
  if (row === null) return notFound(id);
  await env.DB.prepare("UPDATE posts SET cover = NULL WHERE id = ?").bind(id).run();
  if (row.cover !== null) await env.ASSETS.delete(row.cover);
  return json({ post: forAdmin(env, (await find(env, id))!) });
}
