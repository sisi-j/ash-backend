-- News posts (spec 0004, ash-backend#9). Written on /admin; read by the
-- launcher's News page. Nothing here is about an account, so nothing
-- references accounts(uuid).

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('news', 'patch_notes')),
  title TEXT NOT NULL,
  -- The agreed Markdown subset: headings, paragraphs, bold, italic, lists,
  -- links. Rendered by the launcher without HTML strings.
  body TEXT NOT NULL,
  -- The cover image's key in the ASSETS bucket, or null for none.
  cover TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Null while a draft. Only published posts are ever served publicly.
  published_at INTEGER
);
CREATE INDEX posts_by_publication ON posts (published_at);
