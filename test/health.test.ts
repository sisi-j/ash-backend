import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("/health", () => {
  it("says which commit is running and that its database answers", async () => {
    const response = await exports.default.fetch("https://api.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    // "dev" is the local value; a deploy replaces it with the commit.
    expect(await response.json()).toEqual({ commit: "dev", database: "ok" });
  });

  it("refuses anything but GET, with a kind the launcher can match on", async () => {
    const response = await exports.default.fetch("https://api.test/health", { method: "POST" });

    expect(response.status).toBe(405);
    expect(await response.json()).toMatchObject({ error: { kind: "method_not_allowed" } });
  });
});

describe("an unknown path", () => {
  it("is a JSON not_found, never an HTML error page", async () => {
    const response = await exports.default.fetch("https://api.test/nowhere");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { kind: "not_found" } });
  });
});
