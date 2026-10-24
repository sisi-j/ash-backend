# The contract with the launcher and the client

One example per response shape. The backend's tests check every real response against its example: the same keys, with the same JSON types, all the way down. ash-core's fake backend (sisi-j/ash) serves copies of these files. So a shape changed here without the launcher changing fails the launcher's tests, and the other way round (ADR-0021).

| File | Answer to |
| --- | --- |
| `health.json` | `GET /health` |
| `session-challenge.json` | `POST /v1/session/challenge` |
| `session.json` | `POST /v1/session` with `{challenge, uuid, username, certificate: {public_key, expires_at, signature}, signature}`: the player's key from Mojang's `/player/certificates` (`public_key` its X.509 bytes and `signature` Mojang's `publicKeySignatureV2`, both base64; `expires_at` in milliseconds), and the challenge signed with it, SHA256withRSA over `ash-account-sign-in:` and the challenge (ADR-0020, amended) |
| `account.json` | `GET /v1/account`, signed in |
| `settings.json` | `GET /v1/settings` and `PUT /v1/settings` (which takes `{changes: [the same items]}`), signed in. `deleted: true` has an empty `value` |
| `cosmetics.json` | `GET /v1/cosmetics`: the catalogue. Public |
| `wardrobe.json` | `GET /v1/wardrobe` and `PUT /v1/wardrobe` (which takes `{slot, cosmetic_id}`, null to take it off), signed in. An empty slot is `null` |
| `profile.json` | not an endpoint: `profiles/<uuid>.json` on the CDN, read by the game client for players it can see. Absent means no ash cosmetics; a slot not worn is absent |
| `links.json` | `GET /v1/links`: links the launcher shows that can change without a release. `feedback_url` is a Discord invite, or null until one is set. Public |
| `news.json` | `GET /v1/news`: published posts, newest first. `cover_url` may be null; `kind` is `news` or `patch_notes`; `body` is the Markdown subset |
| (no body, 204) | `DELETE /v1/account`, signed in: the account and everything about it are gone |
| `error.json` | every failure. `kind` is the stable part. |

The error kinds so far:
- `invalid_request`;
- `challenge_invalid`;
- `challenge_used`;
- `certificate_expired`: the player's key from Mojang has expired, so get a new one;
- `certificate_invalid`: Mojang didn't certify that key for that player;
- `signature_invalid`: the challenge wasn't signed with that key;
- `not_signed_in`;
- `not_found`;
- `method_not_allowed`.

Values are illustrative. Times are milliseconds since the Unix epoch, and UUIDs are undashed and lowercase.
