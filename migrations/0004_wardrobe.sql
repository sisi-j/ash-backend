-- Capes, step 4 of spec 0004 (sisi-j/ash research 0012). The catalogue is
-- kept in the repo (cosmetics/catalogue.json) and written here by the deploy;
-- what each account wears is kept here, and published as a static file in R2
-- for other players to read without reaching this Worker (ADR-0023).

-- Where the cosmetic's texture is in the ASSETS bucket.
ALTER TABLE cosmetics ADD COLUMN texture TEXT NOT NULL DEFAULT '';

-- One cosmetic per slot per account. Requires an entitlement, which the code
-- checks; deleted with the account like everything about it.
CREATE TABLE equipped (
  uuid TEXT NOT NULL REFERENCES accounts (uuid) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('cape', 'head', 'back')),
  cosmetic_id TEXT NOT NULL REFERENCES cosmetics (id) ON DELETE CASCADE,
  PRIMARY KEY (uuid, slot)
);
