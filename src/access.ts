import { type JWTVerifyGetKey, jwtVerify } from "jose";
import { failure } from "./respond";

/**
 * Cloudflare Access protects /admin (spec 0004, research 0010 §2). Access
 * signs every request it lets through with a JWT in Cf-Access-Jwt-Assertion;
 * this checks that signature itself, against the team's published keys, for
 * this application's AUD. So a misconfigured Access policy - or a request
 * that reaches the Worker some other way - fails closed rather than open.
 */

/** Where an Access team publishes the keys it signs with. */
export type AccessKeys = (teamDomain: string) => JWTVerifyGetKey;

export interface AdminIdentity {
  email: string;
}

export async function verifyAccess(
  request: Request,
  env: Env,
  keys: AccessKeys,
): Promise<AdminIdentity | Response> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) {
    return failure(403, "admin_not_configured", "Cloudflare Access is not configured for this environment");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return failure(403, "admin_forbidden", "this page is only reachable through Cloudflare Access");
  }
  try {
    const { payload } = await jwtVerify(token, keys(team), {
      issuer: `https://${team}`,
      audience: aud,
    });
    if (typeof payload.email !== "string") {
      return failure(403, "admin_forbidden", "the Access token names nobody");
    }
    return { email: payload.email };
  } catch {
    return failure(403, "admin_forbidden", "the Access token did not verify");
  }
}
