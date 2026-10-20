import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
    const canonicalHash = createHash("sha256").update(latest).digest("hex");
    assert.equal(history[1].sha256, canonicalHash, "index must hash exact file bytes");
    assert.equal(db.snapshot("2026-10-20").sha256, canonicalHash);
    const moduleText = await readFile(join(folder, "data.js"), "utf8");
    assert.match(moduleText, /^export const state = /);
    assert.doesNotMatch(moduleText, /private-internal-user/);
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
});


test("export refuses inconsistent stored snapshot hashes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "erosion-integrity-"));
  const db = new Store();
  try {
    db.initialize(new Date("2026-10-20T12:00:00Z"));
    db.db.prepare("UPDATE snapshots SET sha256 = ? WHERE day = ?")
      .run("0".repeat(64), "2026-10-19");
    await assert.rejects(() => exportSnapshots(db, folder), /integrity check failed/);
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
