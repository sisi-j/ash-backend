import type { SignedIn } from "./session";
import { profileKey } from "./wardrobe";

/**
 * Deleting an ash account deletes everything about it (spec 0004; Microsoft
 * identity platform terms §2.2). Every table holding anything about an
 * account keys it in a `uuid` column that references accounts(uuid) ON
 * DELETE CASCADE, so deleting the account row is the whole deletion - a
 * rule test/deletion.test.ts checks against the live schema, table by table.
 */

/** An account nobody has signed in to for this long is deleted. */
export const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

/** DELETE /v1/account */
export async function deleteAccount(who: SignedIn, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM accounts WHERE uuid = ?").bind(who.uuid).run();
  // The public file of what it wore goes with it (ADR-0023).
  await env.ASSETS.delete(profileKey(who.uuid));
  return new Response(null, { status: 204 });
}

/** The daily job: delete every account whose last sign-in is over a year old.
 *  Returns how many went, for the job's log line. */
export async function expireStaleAccounts(env: Env, now: number): Promise<number> {
  // Counted with RETURNING: D1's change count includes the rows the
  // cascade removed, which is not "how many accounts".
  const result = await env.DB.prepare("DELETE FROM accounts WHERE last_sign_in_at < ? RETURNING uuid")
    .bind(now - STALE_AFTER_MS)
    .all<{ uuid: string }>();
  for (const row of result.results) await env.ASSETS.delete(profileKey(row.uuid));
  return result.results.length;
}
