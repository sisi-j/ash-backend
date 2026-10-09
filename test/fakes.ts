import type { Deps } from "../src/deps";
import { type JoinedProfile, type Mojang, MojangUnavailable } from "../src/mojang";

/**
 * A Mojang that confirms exactly the joins a test makes, as the real one
 * does: `join` records that a profile joined a server id, `hasJoined` says
 * who joined it, if anyone. Every question asked is kept for assertions.
 */
export class FakeMojang implements Mojang {
  readonly asked: { username: string; serverId: string }[] = [];
  private readonly joins = new Map<string, JoinedProfile>();
  down = false;

  join(profile: JoinedProfile, serverId: string): void {
    this.joins.set(`${profile.username.toLowerCase()} ${serverId}`, profile);
  }

  async hasJoined(username: string, serverId: string): Promise<JoinedProfile | null> {
    this.asked.push({ username, serverId });
    if (this.down) throw new MojangUnavailable("fake Mojang is down");
    return this.joins.get(`${username.toLowerCase()} ${serverId}`) ?? null;
  }
}

/** A clock the test moves, and randomness that differs call to call. */
export function fakeDeps(mojang: Mojang, start = 1_760_000_000_000): Deps & { advance(ms: number): void } {
  let now = start;
  return {
    mojang,
    now: () => now,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    advance(ms) {
      now += ms;
    },
  };
}
