import { describe, expect, it } from "vitest";
import { minecraftDigest, serverIdFor } from "../src/minecraft-digest";

describe("Minecraft's digest", () => {
  it("matches the protocol's three published examples", async () => {
    expect(await minecraftDigest("Notch")).toBe("4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48");
    expect(await minecraftDigest("jeb_")).toBe("-7c9d5b0044c130109a5d7b5fb5c317c02b4e28c1");
    expect(await minecraftDigest("simon")).toBe("88e16a1019277b15d58faf0541e11910eb756f6");
  });

  it("gives the server id ash-core's join_for_ash joins for the same challenge", async () => {
    // The value ash-core's tests pin (launcher/core/tests/auth.rs), worked out
    // independently in Python. Both sides must agree or no sign-in works.
    expect(await serverIdFor("4f1c2a9b0e7d4c3a8b6f5e4d3c2b1a09")).toBe(
      "655bc2e7697492d992e77e6057eb55cdf7e1d2fd",
    );
  });
});
