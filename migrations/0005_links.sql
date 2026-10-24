-- Links the launcher shows that can change without a release (spec 0005 in
-- sisi-j/ash, ash-backend#19): for now, the Discord invite behind "Send
-- feedback". Set on /admin; served publicly by GET /v1/links. Nothing here is
-- about an account.

CREATE TABLE links (
  name TEXT PRIMARY KEY CHECK (name IN ('feedback')),
  url TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
