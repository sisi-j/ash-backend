import { failure, json } from "./respond";
import type { SignedIn } from "./session";

/**
 * Cosmetics (spec 0004, step 4): the catalogue, what each account is entitled
 * to and wears, and the public file other players' clients read.
 *
 * Phase 4 grants every account the whole catalogue (ADR-0010, amended), as
 * real entitlement rows, so a cosmetic added later is granted the next time
 * the account asks. Nothing is sold.
 */

export const SLOTS = ["cape", "head", "back"] as const;
type Slot = (typeof SLOTS)[number];

/** The public file a player's equipped cosmetics are published as (ADR-0023). */
export function profileKey(uuid: string): string {
  return `profiles/${uuid}.json`;
}

/**
 * How long a profile file may be cached. Short, so a cape changed in the
 * launcher reaches other players within a minute or two.
 */
const PROFILE_CACHE = "public, max-age=60";

interface CosmeticRow {
  id: string;
  slot: Slot;
  name: string;
  texture: string;
}

function textureUrl(env: Env, key: string): string {
  return `${env.ASSETS_URL}/${key}`;
}

/** GET /v1/cosmetics: the catalogue. Public. */
export async function catalogue(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT id, slot, name, texture FROM cosmetics ORDER BY slot, name").all<CosmeticRow>();
  return json(
    { cosmetics: rows.results.map((c) => ({ id: c.id, slot: c.slot, name: c.name, texture_url: textureUrl(env, c.texture) })) },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function grantCatalogue(env: Env, uuid: string, now: number): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO entitlements (uuid, cosmetic_id, granted_at) SELECT ?, id, ? FROM cosmetics")
    .bind(uuid, now)
    .run();
}

async function wardrobeOf(env: Env, uuid: string): Promise<Response> {
  const entitled = await env.DB.prepare("SELECT cosmetic_id FROM entitlements WHERE uuid = ? ORDER BY cosmetic_id")
    .bind(uuid)
    .all<{ cosmetic_id: string }>();
  const worn = await env.DB.prepare("SELECT slot, cosmetic_id FROM equipped WHERE uuid = ?")
    .bind(uuid)
    .all<{ slot: Slot; cosmetic_id: string }>();
  const equipped: Record<Slot, string | null> = { cape: null, head: null, back: null };
  for (const row of worn.results) equipped[row.slot] = row.cosmetic_id;
  return json({ entitled: entitled.results.map((r) => r.cosmetic_id), equipped });
}

/** GET /v1/wardrobe: what the account may wear, and wears. */
export async function wardrobe(who: SignedIn, env: Env, now: number): Promise<Response> {
  await grantCatalogue(env, who.uuid, now);
  return wardrobeOf(env, who.uuid);
}

/**
 * PUT /v1/wardrobe, `{slot, cosmetic_id}` (null takes it off). Then the
 * public profile file is written again: what other players' clients see.
 */
export async function equip(who: SignedIn, request: Request, env: Env, now: number): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { slot?: unknown; cosmetic_id?: unknown } | null;
  const slot = body?.slot;
  const id = body?.cosmetic_id;
  if (typeof slot !== "string" || !(SLOTS as readonly string[]).includes(slot) || !(id === null || typeof id === "string")) {
    return failure(400, "invalid_request", "expected {slot: cape|head|back, cosmetic_id: string|null}");
  }
  await grantCatalogue(env, who.uuid, now);
  if (id === null) {
    await env.DB.prepare("DELETE FROM equipped WHERE uuid = ? AND slot = ?").bind(who.uuid, slot).run();
  } else {
    const allowed = await env.DB.prepare(
      `SELECT c.slot FROM cosmetics c JOIN entitlements e ON e.cosmetic_id = c.id
       WHERE c.id = ? AND e.uuid = ?`,
    )
      .bind(id, who.uuid)
      .first<{ slot: string }>();
    if (allowed === null) {
      return failure(403, "not_entitled", `this account is not entitled to ${id}`);
    }
    if (allowed.slot !== slot) {
      return failure(400, "wrong_slot", `${id} is worn in the ${allowed.slot} slot`);
    }
    await env.DB.prepare(
      "INSERT INTO equipped (uuid, slot, cosmetic_id) VALUES (?, ?, ?) ON CONFLICT (uuid, slot) DO UPDATE SET cosmetic_id = excluded.cosmetic_id",
    )
      .bind(who.uuid, slot, id)
      .run();
  }
  await publishProfile(env, who.uuid);
  return wardrobeOf(env, who.uuid);
}

/**
 * Write the account's public profile file, or delete it when nothing is worn.
 * `{"v": 1, "equipped": {"cape": {"id", "texture_url"}}}`; a missing file
 * means no ash cosmetics, which is also how a player without ash looks.
 */
export async function publishProfile(env: Env, uuid: string): Promise<void> {
  const worn = await env.DB.prepare(
    `SELECT q.slot, c.id, c.texture FROM equipped q JOIN cosmetics c ON c.id = q.cosmetic_id WHERE q.uuid = ?`,
  )
    .bind(uuid)
    .all<{ slot: Slot; id: string; texture: string }>();
  if (worn.results.length === 0) {
    await env.ASSETS.delete(profileKey(uuid));
    return;
  }
  const equipped: Partial<Record<Slot, { id: string; texture_url: string }>> = {};
  for (const row of worn.results) equipped[row.slot] = { id: row.id, texture_url: textureUrl(env, row.texture) };
  await env.ASSETS.put(profileKey(uuid), JSON.stringify({ v: 1, equipped }), {
    httpMetadata: { contentType: "application/json", cacheControl: PROFILE_CACHE },
  });
}
