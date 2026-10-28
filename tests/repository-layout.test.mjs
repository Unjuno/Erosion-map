import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { parse } from "node:path";

test("public repository ships only technical migrations and config examples", async () => {
  const hosting = JSON.parse(await readFile(".openai/hosting.json", "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.equal("project_id" in hosting, false,
    "Sites provisions project_id only when the user creates a site");
  await access("migrations/0001_d1_schema.sql");
  const migration = await readFile("migrations/0002_day_closure.sql", "utf8");
  assert.match(migration, /BEFORE INSERT ON posts/);
  assert.match(migration, /BEFORE UPDATE ON posts/);
  const capture = await readFile("migrations/0003_closed_post_capture.sql", "utf8");
  assert.match(capture, /AFTER INSERT ON day_closures/);
  assert.match(capture, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(capture, /CREATE TABLE.*user_id/i);
  const hardening = await readFile(
    "migrations/0004_archival_and_chunked_states.sql", "utf8");
  assert.match(hardening, /CREATE TABLE IF NOT EXISTS orphaned_posts/);
  assert.match(hardening, /CREATE TABLE IF NOT EXISTS snapshot_chunks/);
  assert.match(hardening, /DELETE FROM posts WHERE day IN/);
  const variables = await readFile(".env.example", "utf8");
  assert.match(variables, /^PUBLIC_ORIGIN=/m);
  assert.doesNotMatch(variables, /(?:sk-proj-|AKIA[0-9A-Z]{16})/);
});
