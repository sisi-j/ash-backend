-- ash accounts, keyed by the Minecraft profile UUID Mojang confirms
-- (ADR-0009, ADR-0020). Every table that holds anything about an account
-- references accounts(uuid) ON DELETE CASCADE, so deleting the account row
-- deletes everything (spec 0004; ash-backend#4 tests it table by table).

-- D1 enforces foreign keys by default; this is for local SQLite tools.
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  -- Undashed, lowercase, as Mojang's hasJoined returns it.
  uuid TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- The 12-month expiry runs from this (ash-backend#4).
  last_sign_in_at INTEGER NOT NULL
);

-- Only a hash of each session token is kept: a copy of this table signs
-- nobody in.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_account ON sessions (uuid);

-- Challenges are signed, not stored, so issuing one writes nothing. A
-- challenge is recorded here only once it has been redeemed, which needs a
-- join Mojang confirmed, so that it cannot be redeemed twice.
CREATE TABLE redeemed_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- The catalogue. Empty until the capes step fills it.
CREATE TABLE cosmetics (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL CHECK (slot IN ('cape', 'head', 'back', 'emote')),
  name TEXT NOT NULL
);

-- An entitlement is the grant of one cosmetic to one account (CONTEXT.md).
-- In Phase 4 every account is granted the whole catalogue (ADR-0010,
-- amended), but as real rows, so granting can change without a new model.
CREATE TABLE entitlements (
  uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics (id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (uuid, cosmetic_id)
);
