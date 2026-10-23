import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import accountExample from "../contract/account.json";
import errorExample from "../contract/error.json";
import sessionExample from "../contract/session.json";
import { CHALLENGE_LIFETIME_MS } from "../src/challenge";
import { SESSION_LIFETIME_MS } from "../src/session";
import { expectShape } from "./contract";
import { FakeMojang } from "./fakes";
import { harness, JEB, NOTCH, reset, rows } from "./harness";

let h: ReturnType<typeof harness>;
let deps: ReturnType<typeof harness>["deps"];
let call: ReturnType<typeof harness>["call"];
let newChallenge: ReturnType<typeof harness>["newChallenge"];
let proofFor: ReturnType<typeof harness>["proofFor"];
let signIn: ReturnType<typeof harness>["signIn"];

beforeEach(async () => {
  h = harness();
  ({ deps, call, newChallenge, proofFor, signIn } = h);
  await reset();
});

async function everyRow(): Promise<number> {
  let total = 0;
  for (const t of ["accounts", "sessions", "redeemed_challenges", "entitlements"]) total += await rows(t);
  return total;
}

async function redeem(body: unknown) {
  return call("POST", "/v1/session", { body });
}

describe("signing in", () => {
  it("creates the account Mojang certified the key for, once, and says it was created", async () => {
    const first = await signIn();

    expect(first.status).toBe(200);
    expectShape(first.body, sessionExample);
    expect(first.body.account).toEqual({ ...NOTCH, created: true });

    const second = await signIn();
    expect(second.status).toBe(200);
    expect(second.body.account.created).toBe(false);
    expect(await rows("accounts")).toBe(1);
  });

  it("refuses a key certified for one player offered as another's", async () => {
    const notch = await proofFor(NOTCH, await newChallenge());

    const { status, body } = await redeem({ ...notch, uuid: JEB.uuid, username: JEB.username });

    expect(status).toBe(401);
    expect(body.error.kind).toBe("certificate_invalid");
    expect(await everyRow()).toBe(0);
  });

  it("updates the username when the player has renamed", async () => {
    await signIn();
    const renamed = await signIn({ ...NOTCH, username: "Notch2" });

    expect(renamed.body.account).toEqual({ uuid: NOTCH.uuid, username: "Notch2", created: false });
    expect(await rows("accounts")).toBe(1);
  });

  it("grants every account the whole catalogue, as real entitlement rows", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cosmetics (id, slot, name) VALUES ('cape.placeholder', 'cape', 'Placeholder cape')"),
      env.DB.prepare("INSERT INTO cosmetics (id, slot, name) VALUES ('emote.wave', 'emote', 'Wave')"),
    ]);

    await signIn();

    const granted = await env.DB.prepare("SELECT cosmetic_id FROM entitlements WHERE uuid = ? ORDER BY cosmetic_id")
      .bind(NOTCH.uuid)
      .all<{ cosmetic_id: string }>();
    expect(granted.results.map((r) => r.cosmetic_id)).toEqual(["cape.placeholder", "emote.wave"]);
  });
});

describe("a challenge", () => {
  it("can be redeemed once", async () => {
    const proof = await proofFor(NOTCH, await newChallenge());

    expect((await redeem(proof)).status).toBe(200);
    const again = await redeem(proof);

    expect(again.status).toBe(409);
    expect(again.body.error.kind).toBe("challenge_used");
    expect(await rows("sessions")).toBe(1);
  });

  it("expires", async () => {
    const proof = await proofFor(NOTCH, await newChallenge());
    deps.advance(CHALLENGE_LIFETIME_MS + 1);

    const { status, body } = await redeem(proof);

    expect(status).toBe(400);
    expect(body.error.kind).toBe("challenge_invalid");
  });

  it("that this service never issued is refused, however well it is signed", async () => {
    const issued = await newChallenge();
    const [expiry, nonce, mac] = issued.split(".");
    const forged = `${expiry}.${nonce!.replace(/.$/, (c) => (c === "0" ? "1" : "0"))}.${mac}`;

    const { status, body } = await redeem(await proofFor(NOTCH, forged));

    expect(status).toBe(400);
    expect(body.error.kind).toBe("challenge_invalid");
    expectShape(body, errorExample);
  });

  it("costs no database write to issue, however many are asked for", async () => {
    const before = await everyRow();
    for (let i = 0; i < 25; i++) await newChallenge();
    expect(await everyRow()).toBe(before);
  });

  it("is different every time", async () => {
    expect(await newChallenge()).not.toBe(await newChallenge());
  });
});

describe("a failed sign-in issues nothing", () => {
  it("when the player's key has expired", async () => {
    const proof = await proofFor(NOTCH, await newChallenge(), { expiresAt: deps.now() });

    const { status, body } = await redeem(proof);

    expect(status).toBe(401);
    expect(body.error.kind).toBe("certificate_expired");
    expect(await everyRow()).toBe(0);
  });

  it("when the key wasn't certified by Mojang", async () => {
    const impostor = await FakeMojang.create();
    const proof = await proofFor(NOTCH, await newChallenge(), { by: impostor });

    const { status, body } = await redeem(proof);

    expect(status).toBe(401);
    expect(body.error.kind).toBe("certificate_invalid");
    expect(await everyRow()).toBe(0);
  });

  it("when the certificate's expiry was changed", async () => {
    const proof = await proofFor(NOTCH, await newChallenge());
    const stretched = { ...proof.certificate, expires_at: proof.certificate.expires_at + 1 };

    const { body } = await redeem({ ...proof, certificate: stretched });

    expect(body.error.kind).toBe("certificate_invalid");
  });

  it("when the challenge was signed by some other key", async () => {
    const challenge = await newChallenge();
    const notch = await proofFor(NOTCH, challenge);
    const jeb = await proofFor(JEB, challenge);

    const { status, body } = await redeem({ ...notch, signature: jeb.signature });

    expect(status).toBe(401);
    expect(body.error.kind).toBe("signature_invalid");
    expect(await everyRow()).toBe(0);
  });

  it("when the signature is over a different challenge", async () => {
    const challenge = await newChallenge();
    const other = await proofFor(NOTCH, await newChallenge());

    const { body } = await redeem({ ...other, challenge });

    expect(body.error.kind).toBe("signature_invalid");
  });

  const someone = { challenge: "x", uuid: NOTCH.uuid, username: "Notch" };
  it.each([
    [{}],
    [{ challenge: "x" }],
    [{ ...someone, uuid: "not-a-uuid" }],
    [{ ...someone, username: "not a name" }],
    [{ ...someone, username: "seventeen_letters" }],
    [{ ...someone, certificate: {}, signature: "AAAA" }],
    [{ ...someone, certificate: { public_key: "not base64!", expires_at: 1, signature: "AAAA" }, signature: "AAAA" }],
    [{ ...someone, certificate: { public_key: "AAAA", expires_at: "soon", signature: "AAAA" }, signature: "AAAA" }],
  ])("when the request is malformed: %j", async (body) => {
    const response = await redeem(body);
    expect(response.status).toBe(400);
    expect(response.body.error.kind).toBe("invalid_request");
  });
});

describe("a session", () => {
  it("signs its account in", async () => {
    const { body } = await signIn();

    const me = await call("GET", "/v1/account", { token: body.session.token });

    expect(me.status).toBe(200);
    expectShape(me.body, accountExample);
    expect(me.body.account).toEqual(NOTCH);
  });

  it("is stored only as a hash", async () => {
    const { body } = await signIn();

    const stored = await env.DB.prepare("SELECT * FROM sessions").all();
    expect(JSON.stringify(stored.results)).not.toContain(body.session.token);
  });

  it("ends when it expires", async () => {
    const { body } = await signIn();
    deps.advance(SESSION_LIFETIME_MS);

    const me = await call("GET", "/v1/account", { token: body.session.token });

    expect(me.status).toBe(401);
    expect(me.body.error.kind).toBe("not_signed_in");
  });

  it("ends when signed out, and only that session ends", async () => {
    const one = (await signIn()).body.session.token;
    const other = (await signIn()).body.session.token;

    expect((await call("DELETE", "/v1/session", { token: one })).status).toBe(204);

    expect((await call("GET", "/v1/account", { token: one })).status).toBe(401);
    expect((await call("GET", "/v1/account", { token: other })).status).toBe(200);
  });

  it("is required, and a made-up token is refused", async () => {
    expect((await call("GET", "/v1/account")).body.error.kind).toBe("not_signed_in");
    const madeUp = "A".repeat(43);
    expect((await call("GET", "/v1/account", { token: madeUp })).body.error.kind).toBe("not_signed_in");
  });
});
