-- 0002: atomic daily cutoff guard for distributed Sites/D1 requests.
-- Execute after 0001_d1_schema.sql. No user data or secrets included.
--
-- Before the publisher reads posts, it INSERTs a closure record. SQLite
-- serializes closure vs. post writes. The triggers refuse submissions once
-- either a closure or a published snapshot exists.
CREATE TABLE IF NOT EXISTS day_closures (
  day TEXT PRIMARY KEY NOT NULL,
  rules_json TEXT NOT NULL,
  user_count INTEGER NOT NULL CHECK(user_count >= 0),
  previous_hash TEXT NOT NULL,
  closed_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS posts_reject_sealed_day_insert
BEFORE INSERT ON posts
BEGIN
  SELECT RAISE(ABORT, 'day already sealed')
    WHERE EXISTS (SELECT 1 FROM day_closures WHERE day = NEW.day)
       OR EXISTS (SELECT 1 FROM snapshots WHERE day = NEW.day);
END;

CREATE TRIGGER IF NOT EXISTS posts_reject_sealed_day_update
BEFORE UPDATE ON posts
BEGIN
  SELECT RAISE(ABORT, 'day already sealed')
    WHERE EXISTS (SELECT 1 FROM day_closures WHERE day = NEW.day)
       OR EXISTS (SELECT 1 FROM snapshots WHERE day = NEW.day);
END;
