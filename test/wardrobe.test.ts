import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import cosmeticsExample from "../contract/cosmetics.json";
import profileExample from "../contract/profile.json";
import wardrobeExample from "../contract/wardrobe.json";
import { expireStaleAccounts, STALE_AFTER_MS } from "../src/deletion";
import { profileKey } from "../src/wardrobe";
import { expectShape } from "./contract";
import { harness, JEB, NOTCH, reset } from "./harness";

let h: ReturnType<typeof harness>;
let token: string;

async function catalogueOf(rows: [id: string, slot: string, name: string][]) {
  await env.DB.batch(
    rows.map(([id, slot, name]) =>
      env.DB.prepare("INSERT INTO cosmetics (id, slot, name, texture) VALUES (?, ?, ?, ?)").bind(id, slot, name, `cosmetics/${id}.png`),
    ),
  );
}

beforeEach(async () => {
  h = harness();
  await reset();
  for (const object of (await env.ASSETS.list()).objects) await env.ASSETS.delete(object.key);
  await catalogueOf([
    ["cape.ash", "cape", "Ash"],
    ["cape.ember", "cape", "Ember"],
  ]);
  token = (await h.signIn(NOTCH)).body.session.token;
});

const equip = (slot: string, cosmetic_id: string | null, as = token) =>
  h.call("PUT", "/v1/wardrobe", { token: as, body: { slot, cosmetic_id } });

async function profile(uuid: string) {
  const object = await env.ASSETS.get(profileKey(uuid));
  return object === null ? null : { body: JSON.parse(await object.text()), meta: object.httpMetadata };
}

describe("the catalogue", () => {
  it("is public, cacheable, and gives each texture's address", async () => {
    const response = await h.call("GET", "/v1/cosmetics");
    expect(response.status).toBe(200);
    expectShape(response.body, cosmeticsExample);
    expect(response.body.cosmetics.map((c: { id: string }) => c.id)).toEqual(["cape.ash", "cape.ember"]);
    expect(response.body.cosmetics[0].texture_url).toBe("https://cdn.test/cosmetics/cape.ash.png");
  });
});

describe("the wardrobe", () => {
  it("is entitled to the whole catalogue, a cosmetic added later included, and starts with nothing worn", async () => {
    await catalogueOf([["cape.midnight", "cape", "Midnight"]]);
    const response = await h.call("GET", "/v1/wardrobe", { token });

    expect(response.status).toBe(200);
    expectShape({ ...response.body, equipped: { ...response.body.equipped, cape: "x" } }, wardrobeExample);
    expect(response.body).toEqual({
      entitled: ["cape.ash", "cape.ember", "cape.midnight"],
      equipped: { cape: null, head: null, back: null },
    });
  });

  it("wears a cape, and publishes it for other players, short-cached", async () => {
    const response = await equip("cape", "cape.ember");

    expect(response.body.equipped.cape).toBe("cape.ember");
    const published = await profile(NOTCH.uuid);
    expectShape(published!.body, profileExample);
    expect(published!.body).toEqual({
      v: 1,
      equipped: { cape: { id: "cape.ember", texture_url: "https://cdn.test/cosmetics/cape.ember.png" } },
    });
    expect(published!.meta?.contentType).toBe("application/json");
    expect(published!.meta?.cacheControl).toBe("public, max-age=60");
  });

  it("changes the published file when the cape changes, and removes it when nothing is worn", async () => {
    await equip("cape", "cape.ember");
    await equip("cape", "cape.ash");
    expect((await profile(NOTCH.uuid))!.body.equipped.cape.id).toBe("cape.ash");

    await equip("cape", null);
    expect(await profile(NOTCH.uuid)).toBeNull();
  });

  it("refuses a cosmetic in the wrong slot, one that doesn't exist, and an unknown slot", async () => {
    await catalogueOf([["hat.crown", "head", "Crown"]]);
    expect((await equip("cape", "hat.crown")).body.error.kind).toBe("wrong_slot");
    expect((await equip("cape", "cape.nonexistent")).body.error.kind).toBe("not_entitled");
    expect((await equip("legs", "cape.ash")).status).toBe(400);
    expect(await profile(NOTCH.uuid)).toBeNull();
  });

  it("is each account's own", async () => {
    const jeb = (await h.signIn(JEB)).body.session.token;
    await equip("cape", "cape.ember");
    expect((await h.call("GET", "/v1/wardrobe", { token: jeb })).body.equipped.cape).toBeNull();
    expect(await profile(JEB.uuid)).toBeNull();
  });

  it("needs a session", async () => {
    expect((await h.call("GET", "/v1/wardrobe")).status).toBe(401);
    expect((await h.call("PUT", "/v1/wardrobe", { body: { slot: "cape", cosmetic_id: "cape.ash" } })).status).toBe(401);
  });
});

describe("deleting the account", () => {
  it("removes its published profile, and what it wore", async () => {
    await equip("cape", "cape.ember");
    expect(await profile(NOTCH.uuid)).not.toBeNull();

    await h.call("DELETE", "/v1/account", { token });

    expect(await profile(NOTCH.uuid)).toBeNull();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM equipped").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("after a year without a sign-in removes its published profile too", async () => {
    await equip("cape", "cape.ember");

    await expireStaleAccounts(env, h.deps.now() + STALE_AFTER_MS + 1);

    expect(await profile(NOTCH.uuid)).toBeNull();
  });
});
