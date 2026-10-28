-- Erosion Map relational schema for SQLite-compatible hosted D1 databases.
-- PUBLIC SCHEMA ONLY. No secrets, identities, data or credentials are included.
-- Application logic MUST provide authenticated user identity and transactional writes.
-- Migrate the real production DB in an environment with D1 support.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK(counter >= 0),
  transports_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS challenges (
  token_hash TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('register','authenticate')),
  challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_challenges_exp ON challenges(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

-- Exactly one final editable submission per user and calendar day.
CREATE TABLE IF NOT EXISTS posts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  char TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_posts_day ON posts(day);

-- Resolved effective rule profile must be persisted when the date is published.
CREATE TABLE IF NOT EXISTS day_config (
  day TEXT PRIMARY KEY NOT NULL,
  post_strength INTEGER NOT NULL DEFAULT 1 CHECK(post_strength >= 1),
  same_glyph_mode TEXT NOT NULL DEFAULT 'sum'
    CHECK(same_glyph_mode IN ('sum','max')),
  min_outbound INTEGER NOT NULL DEFAULT 0 CHECK(min_outbound IN (0,1)),
  rule_override INTEGER NOT NULL DEFAULT 0 CHECK(rule_override IN (0,1))
);
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- Public map snapshots contain only date, bounds and [x,y,char,N] cells.
-- End-user identities/passkeys must NEVER be written to state_json.
CREATE TABLE IF NOT EXISTS snapshots (
  day TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
