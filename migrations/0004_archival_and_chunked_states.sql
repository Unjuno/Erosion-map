-- 0004: Preserve closed JST days through account deletion and store large states.
-- Apply in order 0001 -> 0002 -> 0003 -> 0004.
-- Never store a user identifier or credential in orphaned_posts.
--
-- D1 is a SQLite database; each batch is an atomic transaction. User
-- deletion first copies past, not-yet-sealed posts to this anonymous table
-- and then removes the account in the same batch.
CREATE TABLE IF NOT EXISTS orphaned_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  char TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orphaned_posts_day ON orphaned_posts(day);

-- A single trigger freezes both the still-linked posts and any orphaned
-- submissions. The two streams use disjoint ordinal ranges. It replaces
-- the trigger introduced in migration 0003.
DROP TRIGGER IF EXISTS capture_closed_day_posts;
CREATE TRIGGER capture_closed_day_posts
AFTER INSERT ON day_closures
BEGIN
  INSERT INTO closed_posts(day,post_order,revision,x,y,char)
  SELECT NEW.day, ROW_NUMBER() OVER (ORDER BY user_id),
         revision,x,y,char
  FROM posts WHERE day=NEW.day;

  INSERT INTO closed_posts(day,post_order,revision,x,y,char)
  SELECT NEW.day,
         (SELECT COUNT(*) FROM posts WHERE day=NEW.day)
           + ROW_NUMBER() OVER (ORDER BY id),
         revision,x,y,char
  FROM orphaned_posts WHERE day=NEW.day;
END;

-- A snapshot can be stored inline in snapshots.state_json, or as a marker
-- plus ordered chunks. Chunks have a foreign key to the snapshot so a
-- failed/competing write cannot leave a committed partial snapshot.
CREATE TABLE IF NOT EXISTS snapshot_chunks (
  day TEXT NOT NULL REFERENCES snapshots(day) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  chunk_data TEXT NOT NULL,
  PRIMARY KEY(day,chunk_index)
);

-- Old deployments kept already-published, identifying post records.
-- Those rows no longer contribute to future calculations or historical
-- recovery; only the immutable public snapshots remain.
DELETE FROM posts WHERE day IN (SELECT day FROM snapshots);
DELETE FROM closed_posts WHERE day IN (SELECT day FROM snapshots);
