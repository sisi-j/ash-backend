import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AccessKeys } from "../src/access";

/**
 * A stand-in for a Cloudflare Access team: a key pair made for the tests,
 * its public half served as the team's key set, and a way to sign the JWT
 * Access would put in Cf-Access-Jwt-Assertion.
 */
export const TEAM = "ash-test.cloudflareaccess.com";
export const AUD = "test-aud-0123456789abcdef";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
const keySet = createLocalJWKSet({ keys: [jwk] });

/** Keys for the right team only; any other team has none. */
export const accessKeys: AccessKeys = (team) =>
  team === TEAM ? keySet : createLocalJWKSet({ keys: [] });

export async function accessToken(
  claims: { email?: string; aud?: string; iss?: string; expiresIn?: string } = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  const jwt = new SignJWT(claims.email === undefined ? { email: "owner@example.com" } : { email: claims.email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(claims.iss ?? `https://${TEAM}`)
    .setAudience(claims.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? "1h");
  return jwt.sign(key);
}

/** A key nobody in the team knows, for a forged token. */
export const strangerKey = (await generateKeyPair("RS256")).privateKey;
