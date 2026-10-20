import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";
import { exportSnapshots } from "../scripts/export-states.mjs";

test("static export includes only public snapshots, no account details", async () => {
  const folder = await mkdtemp(join(tmpdir(), "erosion-export-"));
  const db = new Store();
  try {
    db.initialize(new Date("2026-10-20T12:00:00Z"));
    db.createUser("private-internal-user");
    db.submit("private-internal-user", "2026-10-20", 1, 2, "星");
    db.publishDay("2026-10-20");
    const result = await exportSnapshots(db, folder);
    assert.equal(result.days, 2);
    assert.equal(result.latestDay, "2026-10-20");
    const latest = await readFile(join(folder, "data/state-2026-10-20.json"), "utf8");
    assert.equal(JSON.parse(latest).cells[0].char, "星");
    assert.doesNotMatch(latest, /private-internal-user/);
    const history = JSON.parse(await readFile(join(folder, "data/index.json"), "utf8"));
    assert.equal(history.length, 2);
    const moduleText = await readFile(join(folder, "data.js"), "utf8");
    assert.match(moduleText, /^export const state = /);
    assert.doesNotMatch(moduleText, /private-internal-user/);
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
