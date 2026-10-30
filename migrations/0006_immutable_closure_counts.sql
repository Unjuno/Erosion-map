-- 0006: persist the exact anonymous submission count at day closure.
-- Apply once, after 0001 -> 0002 -> 0003 -> 0004 -> 0005.
--
-- Without a durable count, deletion of the original user means a damaged
-- closed_posts table could silently publish an empty/incomplete map.
-- This migration stores only a count; no identity, credential or glyph.
ALTER TABLE day_closures
  ADD COLUMN captured_post_count INTEGER
  CHECK(captured_post_count >= 0);

-- The new trigger copies all accepted posts and records their count inside
-- the very same SQLite INSERT transaction. An empty day legitimately has 0.
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

  UPDATE day_closures
  SET captured_post_count=(
    SELECT COUNT(*) FROM closed_posts WHERE day=NEW.day
  )
  WHERE day=NEW.day;
END;

-- Older sealed days predate this count. Establish the best available
-- baseline from surviving frozen rows. Pre-existing missing rows cannot
-- be reconstructed from a count migration; verify backups separately.
UPDATE day_closures
SET captured_post_count=(
  SELECT COUNT(*) FROM closed_posts WHERE day=day_closures.day
)
WHERE captured_post_count IS NULL;
