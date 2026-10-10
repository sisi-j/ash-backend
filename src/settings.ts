import type { Deps } from "./deps";
import { failure, json } from "./respond";
import type { SignedIn } from "./session";

/**
 * Synced settings (spec 0004, ADR-0022): one flat map per account. Each key
 * keeps its own time and the latest change wins, key by key, so a newer
 * change on one machine never undoes an unrelated one from another.
 */

export const KEY = /^(feature|launcher|instance|servers):[A-Za-z0-9._:-]{1,120}$/;
export const VALUE_MAX = 64 * 1024;
export const KEYS_MAX = 500;
export const CHANGES_MAX = 200;

interface Row {
  key: string;
  value: string;
  deleted: number;
  updated_at: number;
}

function shown(row: Row) {
  return { key: row.key, value: row.value, deleted: row.deleted === 1, updated_at: row.updated_at };
}

async function all(env: Env, uuid: string): Promise<Response> {
  const rows = await env.DB.prepare("SELECT key, value, deleted, updated_at FROM settings WHERE uuid = ? ORDER BY key")
    .bind(uuid)
    .all<Row>();
  return json({ settings: rows.results.map(shown) });
}

/** GET /v1/settings */
export function getSettings(who: SignedIn, env: Env): Promise<Response> {
  return all(env, who.uuid);
}

/**
 * PUT /v1/settings, `{changes: [{key, value, deleted, updated_at}]}`: each
 * change is kept only if it is newer than what is stored for its key. The
 * answer is the whole map after, so the caller applies what it lacks.
 */
export async function putSettings(who: SignedIn, request: Request, env: Env, deps: Deps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { changes?: unknown } | null;
  if (!Array.isArray(body?.changes) || body.changes.length > CHANGES_MAX) {
    return failure(400, "invalid_request", `expected {changes: [...]}, up to ${CHANGES_MAX} at once`);
  }
  const now = deps.now();
  const changes: Row[] = [];
  for (const raw of body.changes as unknown[]) {
    const c = raw as Partial<{ key: unknown; value: unknown; deleted: unknown; updated_at: unknown }>;
    if (
      typeof c.key !== "string" ||
      !KEY.test(c.key) ||
      typeof c.value !== "string" ||
      c.value.length > VALUE_MAX ||
      typeof c.deleted !== "boolean" ||
      typeof c.updated_at !== "number" ||
      !Number.isSafeInteger(c.updated_at) ||
      c.updated_at < 0
    ) {
      return failure(400, "invalid_request", `a change is {key, value, deleted, updated_at}; ${JSON.stringify(raw).slice(0, 80)} is not`);
    }
    changes.push({
      key: c.key,
      value: c.deleted ? "" : c.value,
      deleted: c.deleted ? 1 : 0,
      // A machine whose clock runs fast must not win every later conflict.
      updated_at: Math.min(c.updated_at, now),
    });
  }

  const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE uuid = ?").bind(who.uuid).first<{ n: number }>();
  const known = await env.DB.prepare("SELECT key FROM settings WHERE uuid = ?").bind(who.uuid).all<{ key: string }>();
  const existing = new Set(known.results.map((r) => r.key));
  const added = new Set(changes.map((c) => c.key).filter((k) => !existing.has(k))).size;
  if (stored!.n + added > KEYS_MAX) {
    return failure(413, "too_many_settings", `an account keeps up to ${KEYS_MAX} settings`);
  }

  if (changes.length > 0) {
    await env.DB.batch(
      changes.map((c) =>
        env.DB.prepare(
          `INSERT INTO settings (uuid, key, value, deleted, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (uuid, key) DO UPDATE SET value = excluded.value, deleted = excluded.deleted,
             updated_at = excluded.updated_at
           WHERE excluded.updated_at > settings.updated_at`,
        ).bind(who.uuid, c.key, c.value, c.deleted, c.updated_at),
      ),
    );
  }
  return all(env, who.uuid);
}
