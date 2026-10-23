import { describe, expect, it } from "vitest";
import mojangKeys from "../src/mojang-keys.json";
import { certifiedBytes, fromBase64, importMojangKeys, toBase64 } from "../src/player-certificate";

describe("the bytes Mojang certifies a player's key with", () => {
  it("are the UUID, the expiry in milliseconds, then the key, all big-endian, as the game builds them", () => {
    const bytes = certifiedBytes("0123456789abcdef0011223344556677", 0x0001020304050607, new Uint8Array([0xaa, 0xbb]));

    expect(Array.from(bytes)).toEqual([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x00, 0x01, 0x02,
      0x03, 0x04, 0x05, 0x06, 0x07, 0xaa, 0xbb,
    ]);
  });
});

describe("Mojang's keys, as bundled", () => {
  it("are all RSA keys this Worker can verify with", async () => {
    const keys = await importMojangKeys(mojangKeys.playerCertificateKeys);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.usages).toEqual(["verify"]);
  });
});

describe("base64", () => {
  it("round-trips, and anything that isn't standard base64 is null", () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(fromBase64("not base64!")).toBeNull();
    expect(fromBase64("abc")).toBeNull();
  });
});
