import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

test("public distribution does not contain unpublished management documents or data", () => {
  assert.equal(existsSync("docs/HANDOFF.md"), false);
  assert.equal(existsSync("site/.env"), false);
  assert.equal(existsSync("site/user-data.sqlite"), false);
  assert.doesNotThrow(() => execFileSync(
    process.execPath, ["scripts/check-public-bundle.mjs"],
    { encoding: "utf8" },
  ));
});
