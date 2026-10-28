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
  const variables = await readFile(".env.example", "utf8");
  assert.match(variables, /^PUBLIC_ORIGIN=/m);
  assert.doesNotMatch(variables, /(?:sk-proj-|AKIA[0-9A-Z]{16})/);
});
