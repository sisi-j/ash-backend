# The contract with the launcher and the client

One example per response shape. The backend's tests check every real response against its example: the same keys, with the same JSON types, all the way down. ash-core's fake backend (sisi-j/ash) serves copies of these files. So a shape changed here without the launcher changing fails the launcher's tests, and the other way round (ADR-0021).

| File | Answer to |
| --- | --- |
| `health.json` | `GET /health` |
| `session-challenge.json` | `POST /v1/session/challenge` |
| `session.json` | `POST /v1/session` with `{challenge, username}` |
| `account.json` | `GET /v1/account`, signed in |
| `news.json` | `GET /v1/news`: published posts, newest first. `cover_url` may be null; `kind` is `news` or `patch_notes`; `body` is the Markdown subset |
| (no body, 204) | `DELETE /v1/account`, signed in: the account and everything about it are gone |
| `error.json` | every failure. `kind` is the stable part. |

The error kinds so far:
- `invalid_request`;
- `challenge_invalid`;
- `challenge_used`;
- `not_joined`;
- `mojang_unavailable`, which is retryable and never means "not signed in";
- `not_signed_in`;
- `not_found`;
- `method_not_allowed`.

Values are illustrative. Times are milliseconds since the Unix epoch, and UUIDs are undashed and lowercase.
