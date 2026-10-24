import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import linksExample from "../contract/links.json";
import { handle } from "../src/app";
import { accessToken } from "./access-keys";
import { expectShape } from "./contract";
import { fakeDeps } from "./fakes";
import { reset } from "./harness";

let deps: ReturnType<typeof fakeDeps>;

beforeEach(async () => {
  deps = fakeDeps();
  await reset();
});

async function call(method: string, path: string, opts: { json?: unknown; admin?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.admin) headers["cf-access-jwt-assertion"] = await accessToken();
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  const response = await handle(
    new Request(`https://api.test${path}`, {
      method,
      headers,
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    }),
    env,
    deps,
  );
  return { status: response.status, body: (await response.json()) as any, headers: response.headers };
}

describe("the launcher's links", () => {
  it("have no feedback link until one is set, so the launcher shows none", async () => {
    const { status, body } = await call("GET", "/v1/links");
    expect(status).toBe(200);
    expect(body).toEqual({ feedback_url: null });
  });

  it("serve the Discord invite set on /admin, publicly and briefly cached", async () => {
    const set = await call("PUT", "/admin/api/links", { admin: true, json: { feedback_url: "https://discord.gg/ash-alpha" } });
    expect(set.status).toBe(200);

    const { body, headers } = await call("GET", "/v1/links");

    expectShape(body, linksExample);
    expect(body.feedback_url).toBe("https://discord.gg/ash-alpha");
    expect(headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("take a new invite in place of the old, and null takes it down", async () => {
    await call("PUT", "/admin/api/links", { admin: true, json: { feedback_url: "https://discord.gg/first" } });
    await call("PUT", "/admin/api/links", { admin: true, json: { feedback_url: "https://discord.com/invite/second" } });
    expect((await call("GET", "/v1/links")).body.feedback_url).toBe("https://discord.com/invite/second");

    await call("PUT", "/admin/api/links", { admin: true, json: { feedback_url: null } });
    expect((await call("GET", "/v1/links")).body.feedback_url).toBeNull();
  });

  it.each(["https://evil.example/discord.gg/x", "http://discord.gg/x", "javascript:alert(1)", "https://discord.gg/", 42])(
    "refuse anything but a Discord invite: %s",
    async (url) => {
      const { status, body } = await call("PUT", "/admin/api/links", { admin: true, json: { feedback_url: url } });
      expect(status).toBe(400);
      expect(body.error.kind).toBe("invalid_request");
    },
  );

  it("can only be changed through Cloudflare Access", async () => {
    const { status } = await call("PUT", "/admin/api/links", { json: { feedback_url: "https://discord.gg/x" } });
    expect(status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM links").first("n")).toBe(0);
  });
});
