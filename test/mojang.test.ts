import { describe, expect, it } from "vitest";
import { createMojang, MojangUnavailable, USER_AGENT } from "../src/mojang";

function answering(status: number, body?: unknown) {
  const requested: string[] = [];
  const agents: (string | null)[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(String(input));
    agents.push(new Headers(init?.headers).get("User-Agent"));
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { mojang: createMojang(fetchFn), requested, agents };
}

describe("Mojang's hasJoined", () => {
  it("asks for the username and server id given, and normalises the UUID", async () => {
    const { mojang, requested } = answering(200, {
      id: "986DEC87-B7EC-47FF-89FF-033FDB95C4B5",
      name: "Notch",
      properties: [],
    });

    const profile = await mojang.hasJoined("Notch", "-7c9d5b00");

    expect(requested).toEqual([
      "https://sessionserver.mojang.com/session/minecraft/hasJoined?username=Notch&serverId=-7c9d5b00",
    ]);
    expect(profile).toEqual({ uuid: "986dec87b7ec47ff89ff033fdb95c4b5", username: "Notch" });
  });

  it("says who is asking: a request with no User-Agent can be turned away", async () => {
    const { mojang, agents } = answering(204);
    await mojang.hasJoined("Notch", "abc");
    expect(agents).toEqual([USER_AGENT]);
  });

  it("keeps what Mojang said when it refuses, for the log", async () => {
    const { mojang } = answering(403, { error: "ForbiddenOperationException" });
    await expect(mojang.hasJoined("Notch", "abc")).rejects.toThrow(/403: .*ForbiddenOperationException/);
  });

  it("names a block page by its title rather than its first bytes", async () => {
    const page = "<!DOCTYPE html>\n<html><head>\n<title>\n  Access Denied\n</title></head><body>long</body></html>";
    const fetchFn = (async () => new Response(page, { status: 403 })) as typeof fetch;
    await expect(createMojang(fetchFn).hasJoined("Notch", "abc")).rejects.toThrow("hasJoined answered 403: Access Denied");
  });

  it("reads 204 as 'did not join'", async () => {
    expect(await answering(204).mojang.hasJoined("Notch", "abc")).toBeNull();
  });

  it.each([429, 500, 503])("reads %i as Mojang being unavailable, never as 'did not join'", async (status) => {
    await expect(answering(status).mojang.hasJoined("Notch", "abc")).rejects.toBeInstanceOf(MojangUnavailable);
  });

  it("reads a 200 without a usable profile as Mojang being unavailable", async () => {
    await expect(answering(200, { name: "Notch" }).mojang.hasJoined("Notch", "abc")).rejects.toBeInstanceOf(
      MojangUnavailable,
    );
  });

  it("reads a network failure as Mojang being unavailable", async () => {
    const mojang = createMojang((async () => {
      throw new TypeError("network");
    }) as typeof fetch);
    await expect(mojang.hasJoined("Notch", "abc")).rejects.toBeInstanceOf(MojangUnavailable);
  });
});
