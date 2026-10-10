-- Synced settings (spec 0004, ADR-0022, sisi-j/ash research 0011): one flat
-- map per account. Each key keeps its own time, and the latest change wins.
-- Deleted with the account, like everything about it.

CREATE TABLE settings (
  uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
  -- feature:<property>, launcher:<preference>, instance:<sync id>,
  -- servers:<sync id>.
  key TEXT NOT NULL,
  -- As the launcher wrote it: a property's value, or JSON for an instance
  -- or a server list. Empty when deleted.
  value TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, key)
);
