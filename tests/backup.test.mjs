import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";

test("database reads reject corrupted snapshot hashes", () => {
  const store = new Store();
  try {
    store.initialize(new Date("2026-10-20T12:00:00Z"));
    const valid = store.snapshot("2026-10-19");
    assert.ok(valid?.state);
    store.db.prepare("UPDATE snapshots SET sha256=? WHERE day=?")
      .run("0".repeat(64), "2026-10-19");
    assert.throws(() => store.snapshot("2026-10-19"), /integrity check failed/);
    assert.throws(() => store.latestState(), /integrity check failed/);
    assert.throws(() => store.publishDay("2026-10-20"), /integrity check failed/);
  } finally {
    store.close();
  }
});

test("SQLite online backup preserves users, posts and verified snapshots", async () => {
  const folder = await mkdtemp(join(tmpdir(), "erosion-backup-"));
  try {
    const original = new Store(join(folder, "main.sqlite"));
    const backup = join(folder, "backup.sqlite");
    original.initialize(new Date("2026-10-20T12:00:00Z"));
    original.createUser("example-account");
    original.submit("example-account", "2026-10-20", 5, 6, "海");
    original.publishDay("2026-10-20");
    original.backupTo(backup);
    original.close();

    const restored = new Store(backup);
    try {
      assert.equal(restored.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(restored.usersCount(), 1);
      assert.equal(restored.latestState().date, "2026-10-20");
      assert.deepEqual(restored.snapshot("2026-10-20").state.cells,
        [{ x: 5, y: 6, char: "海", n: 1 }]);
      assert.equal(restored.currentPost("example-account", "2026-10-20").char, "海");
    } finally {
      restored.close();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
