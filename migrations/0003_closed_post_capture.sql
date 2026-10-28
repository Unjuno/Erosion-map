-- 0003: Freeze final submissions atomically with daily closure.
-- A cascade delete of an account must not erase posts already sealed for
-- the public day. No user IDs, passkeys, or session data enter this table.
-- The anonymous copies are deleted in the same transaction as publication.
CREATE TABLE IF NOT EXISTS closed_posts (
  day TEXT NOT NULL REFERENCES day_closures(day) ON DELETE CASCADE,
  post_order INTEGER NOT NULL CHECK (post_order >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  char TEXT NOT NULL,
  PRIMARY KEY (day, post_order)
);

-- D1/SQLite executes this trigger in the same write transaction as the
-- day_closures INSERT. A concurrent account deletion is serialized before
-- or after the capture; it cannot split an accepted day's final post set.
CREATE TRIGGER IF NOT EXISTS capture_closed_day_posts
AFTER INSERT ON day_closures
BEGIN
  INSERT INTO closed_posts(day, post_order, revision, x, y, char)
  SELECT NEW.day, ROW_NUMBER() OVER (ORDER BY user_id),
         revision, x, y, char
  FROM posts
  WHERE day = NEW.day;
END;

-- For an existing installation upgraded from 0002, preserve sealed,
-- unpublished posts still available in posts. Already deleted rows
-- cannot be recovered by any migration; back up before upgrading.
INSERT OR IGNORE INTO closed_posts(day, post_order, revision, x, y, char)
SELECT p.day, ROW_NUMBER() OVER (PARTITION BY p.day ORDER BY p.user_id),
       p.revision, p.x, p.y, p.char
FROM posts AS p
JOIN day_closures AS closure ON closure.day = p.day
WHERE NOT EXISTS (
  SELECT 1 FROM snapshots AS snapshot WHERE snapshot.day = p.day
);
