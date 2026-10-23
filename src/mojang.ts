/**
 * Mojang's session server, as this service uses it: one question, "did this
 * player join this server id?" (ADR-0020). Handed to the code that needs it,
 * so tests pass a fake and never reach the network.
 */
export interface Mojang {
  /** The profile that joined, or null if that player did not join that id.
   *  Throws MojangUnavailable when Mojang cannot say. */
  hasJoined(username: string, serverId: string): Promise<JoinedProfile | null>;
}

export interface JoinedProfile {
  /** Undashed lowercase UUID - the ash account key (ADR-0009). */
  uuid: string;
  username: string;
}

/** Mojang throttled, failed or could not be reached. Never "not signed in". */
export class MojangUnavailable extends Error {}

const HAS_JOINED = "https://sessionserver.mojang.com/session/minecraft/hasJoined";

/** Who is asking. A Worker's fetch sends no User-Agent of its own, and a
 *  request without one is the kind a site's bot protection turns away. */
export const USER_AGENT = "ash-backend (+https://ashlauncher.com)";

export function createMojang(fetchFn: typeof fetch): Mojang {
  return {
    async hasJoined(username, serverId) {
      const url = `${HAS_JOINED}?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId)}`;
      let response: Response;
      try {
        response = await fetchFn(url, { headers: { "User-Agent": USER_AGENT } });
      } catch (e) {
        throw new MojangUnavailable(`hasJoined unreachable: ${String(e)}`);
      }
      if (response.status === 204) return null;
      if (response.status !== 200) {
        const said = (await response.text().catch(() => "")).slice(0, 200);
        throw new MojangUnavailable(`hasJoined answered ${response.status}${said ? `: ${said}` : ""}`);
      }
      const body = (await response.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
      const uuid = typeof body?.id === "string" ? normaliseUuid(body.id) : null;
      if (uuid === null || typeof body?.name !== "string") {
        throw new MojangUnavailable("hasJoined answered 200 without a profile");
      }
      return { uuid, username: body.name };
    },
  };
}

export function normaliseUuid(raw: string): string | null {
  const undashed = raw.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(undashed) ? undashed : null;
}
