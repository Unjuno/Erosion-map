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
  const rates = await readFile("migrations/0005_durable_rate_limits.sql", "utf8");
  assert.match(rates, /CREATE TABLE IF NOT EXISTS rate_limits/);
  assert.doesNotMatch(rates, /raw_ip|ip_address|credential_id/i);
  const frozenCounts = await readFile(
    "migrations/0006_immutable_closure_counts.sql", "utf8");
  assert.match(frozenCounts, /captured_post_count/);
  assert.match(frozenCounts, /AFTER INSERT ON day_closures/);
  assert.match(frozenCounts, /COUNT\(\*\) FROM closed_posts/);
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /ChatGPT Sitesは未公開/);
  assert.match(readme, /新しく作成した空のD1/);
  assert.match(readme, /既存のD1が後から確認された場合だけ/);
  assert.match(readme, /プレビューの実在・D1マイグレーション完了/);
  const variables = await readFile(".env.example", "utf8");
  assert.match(variables, /^PUBLIC_ORIGIN=/m);
  assert.doesNotMatch(variables, /(?:sk-proj-|AKIA[0-9A-Z]{16})/);
});
