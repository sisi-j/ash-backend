import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import newsExample from "../contract/news.json";
import { handle } from "../src/app";
import { COVER_MAX_BYTES } from "../src/news";
import { AUD, accessToken, strangerKey, TEAM } from "./access-keys";
import { expectShape } from "./contract";
import { fakeDeps } from "./fakes";
import { reset } from "./harness";

let deps: ReturnType<typeof fakeDeps>;

beforeEach(async () => {
  deps = fakeDeps();
  await reset();
  const listed = await env.ASSETS.list();
  for (const object of listed.objects) await env.ASSETS.delete(object.key);
});

async function call(
  method: string,
  path: string,
  opts: { json?: unknown; bytes?: Uint8Array; type?: string; token?: string | null; envOverride?: Partial<Env> } = {},
) {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? await accessToken() : opts.token;
  if (token !== null) headers["cf-access-jwt-assertion"] = token;
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.bytes !== undefined) {
    headers["content-type"] = opts.type ?? "image/png";
    body = opts.bytes;
  }
  const response = await handle(
    new Request(`https://api.test${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }),
    { ...env, ...opts.envOverride } as Env,
    deps,
  );
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function draft(fields: { kind?: string; title?: string; body?: string } = {}) {
  const { status, body } = await call("POST", "/admin/api/posts", {
    json: { kind: "news", title: "Hello", body: "Some **news**.", ...fields },
  });
  expect(status).toBe(201);
  return body.post as { id: string; cover_url: string | null; published_at: number | null };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("/admin is Cloudflare Access's alone", () => {
  it.each([
    ["no token", null],
    ["a token for another application", "aud"],
    ["a token from another team", "iss"],
    ["an expired token", "exp"],
    ["a token signed by a stranger", "key"],
  ])("refuses %s, on the page, its script and its API", async (_name, broken) => {
    const token =
      broken === null
        ? null
        : broken === "aud"
          ? await accessToken({ aud: "someone-else" })
          : broken === "iss"
            ? await accessToken({ iss: "https://other.cloudflareaccess.com" })
            : broken === "exp"
              ? await accessToken({ expiresIn: "-1m" })
              : await accessToken({}, strangerKey);
    for (const [method, path] of [
      ["GET", "/admin"],
      ["GET", "/admin/app.js"],
      ["GET", "/admin/api/posts"],
      ["POST", "/admin/api/posts"],
    ] as const) {
      const response = await call(method, path, { token, json: method === "POST" ? {} : undefined });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.body.error.kind).toBe("admin_forbidden");
    }
  });

  it("refuses everything when Access is not configured, even with a good token", async () => {
    for (const envOverride of [{ ACCESS_AUD: "" }, { ACCESS_TEAM_DOMAIN: "" }]) {
      const response = await call("GET", "/admin/api/posts", { envOverride });
      expect(response.status).toBe(403);
      expect(response.body.error.kind).toBe("admin_not_configured");
    }
  });

  it("serves the page with a good token, never cached, under a strict CSP", async () => {
    expect(TEAM).toBe(env.ACCESS_TEAM_DOMAIN);
    expect(AUD).toBe(env.ACCESS_AUD);
    const response = await call("GET", "/admin");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(String(response.body)).toContain('<script src="/admin/app.js">');
  });
});

describe("posts", () => {
  it("without a cover have a null cover_url", async () => {
    const post = await draft();
    await call("POST", `/admin/api/posts/${post.id}/publish`);
    expect((await call("GET", "/v1/news", { token: null })).body.posts[0].cover_url).toBeNull();
  });

  it("are drafts until published, and drafts never reach /v1/news", async () => {
    const post = await draft();

    expect((await call("GET", "/v1/news", { token: null })).body.posts).toEqual([]);
    const listed = await call("GET", "/admin/api/posts");
    expect(listed.body.posts.map((p: { id: string }) => p.id)).toEqual([post.id]);
  });

  it("are published newest first, matching the contract, and can be withdrawn", async () => {
    const first = await draft({ title: "First", kind: "patch_notes" });
    await call("PUT", `/admin/api/posts/${first.id}/cover`, { bytes: PNG });
    await call("POST", `/admin/api/posts/${first.id}/publish`);
    deps.advance(1000);
    const second = await draft({ title: "Second" });
    await call("PUT", `/admin/api/posts/${second.id}/cover`, { bytes: PNG });
    await call("POST", `/admin/api/posts/${second.id}/publish`);

    const news = await call("GET", "/v1/news", { token: null });
    expect(news.status).toBe(200);
    expect(news.headers.get("cache-control")).toBe("public, max-age=60");
    expectShape(news.body, newsExample);
    expect(news.body.posts.map((p: { title: string }) => p.title)).toEqual(["Second", "First"]);

    await call("POST", `/admin/api/posts/${second.id}/unpublish`);
    const after = await call("GET", "/v1/news", { token: null });
    expect(after.body.posts.map((p: { title: string }) => p.title)).toEqual(["First"]);
  });

  it("are edited in place, and refused when not news or patch notes, untitled or too long", async () => {
    const post = await draft();
    const edited = await call("PUT", `/admin/api/posts/${post.id}`, {
      json: { kind: "patch_notes", title: "  Renamed  ", body: "New body" },
    });
    expect(edited.body.post).toMatchObject({ kind: "patch_notes", title: "Renamed", body: "New body" });

    for (const json of [
      { kind: "blog", title: "x", body: "" },
      { kind: "news", title: "   ", body: "" },
      { kind: "news", title: "x".repeat(121), body: "" },
      { kind: "news", title: "x", body: "x".repeat(20_001) },
    ]) {
      const refused = await call("PUT", `/admin/api/posts/${post.id}`, { json });
      expect(refused.status, JSON.stringify(json).slice(0, 60)).toBe(400);
    }
  });

  it("that don't exist are not_found, not created", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    expect((await call("PUT", `/admin/api/posts/${missing}`, { json: { kind: "news", title: "x", body: "" } })).status).toBe(404);
    expect((await call("POST", `/admin/api/posts/${missing}/publish`)).status).toBe(404);
    expect((await call("GET", "/admin/api/posts")).body.posts).toEqual([]);
  });
});

describe("a cover", () => {
  it("is stored under a fresh key, served from the assets URL, and replaces the old one", async () => {
    const post = await draft();

    const first = await call("PUT", `/admin/api/posts/${post.id}/cover`, { bytes: PNG, type: "image/png" });
    expect(first.status).toBe(200);
    const firstUrl: string = first.body.post.cover_url;
    expect(firstUrl).toMatch(new RegExp(`^https://cdn\\.test/news/${post.id}-[0-9a-f]{8}\\.png$`));
    const firstKey = firstUrl.replace("https://cdn.test/", "");
    const stored = await env.ASSETS.get(firstKey);
    expect(stored?.httpMetadata?.contentType).toBe("image/png");

    const second = await call("PUT", `/admin/api/posts/${post.id}/cover`, { bytes: PNG, type: "image/webp" });
    expect(second.body.post.cover_url).toMatch(/\.webp$/);
    expect(await env.ASSETS.get(firstKey)).toBeNull();
    expect((await env.ASSETS.list()).objects).toHaveLength(1);
  });

  it("must be a PNG, JPEG or WebP of up to 2 MB", async () => {
    const post = await draft();

    const gif = await call("PUT", `/admin/api/posts/${post.id}/cover`, { bytes: PNG, type: "image/gif" });
    expect(gif.status).toBe(415);
    const huge = await call("PUT", `/admin/api/posts/${post.id}/cover`, {
      bytes: new Uint8Array(COVER_MAX_BYTES + 1),
      type: "image/jpeg",
    });
    expect(huge.status).toBe(413);
    expect((await env.ASSETS.list()).objects).toHaveLength(0);
  });

  it("goes when it's removed, and when its post is deleted", async () => {
    const one = await draft();
    const two = await draft();
    await call("PUT", `/admin/api/posts/${one.id}/cover`, { bytes: PNG });
    await call("PUT", `/admin/api/posts/${two.id}/cover`, { bytes: PNG });
    expect((await env.ASSETS.list()).objects).toHaveLength(2);

    const removed = await call("DELETE", `/admin/api/posts/${one.id}/cover`);
    expect(removed.body.post.cover_url).toBeNull();
    expect((await call("DELETE", `/admin/api/posts/${two.id}`)).status).toBe(204);

    expect((await env.ASSETS.list()).objects).toHaveLength(0);
  });
});
