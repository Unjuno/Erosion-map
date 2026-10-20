import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.mjs";

test("SQLite persists only the latest daily edit with incremented revision", () => {
  const db = new Store();
  db.initialize(new Date("2026-10-20T12:00:00Z"));
  const id = db.createUser("user-1");
  assert.equal(db.submit(id, "2026-10-20", 1, 2, "日").revision, 1);
  assert.equal(db.submit(id, "2026-10-20", 3, 4, "月").revision, 2);
  assert.equal(db.dailyPosts("2026-10-20").length, 1);
  assert.equal(db.dailyPosts("2026-10-20")[0].revision, 2);
  assert.equal(db.dailyPosts("2026-10-20")[0].char, "月");
  db.close();
});

test("snapshots are immutable, idempotent and close posting", () => {
  const db = new Store();
  db.initialize(new Date("2026-10-20T12:00:00Z"));
  db.createUser("user-1");
  db.submit("user-1", "2026-10-20", 0, 0, "海");
  const first = db.publishDay("2026-10-20");
  assert.equal(first.existed, false);
  assert.deepEqual(first.state.cells, [{ x: 0, y: 0, char: "海", n: 1 }]);
  assert.equal(db.publishDay("2026-10-20").existed, true);
  assert.throws(() => db.submit("user-1", "2026-10-20", 0, 0, "山"), /closed/);
  assert.throws(() => db.publishDay("2026-10-22"), /skip/);
  db.close();
});

test("scheduler uses JST day boundary and skips the open day", () => {
  const db = new Store();
  db.initialize(new Date("2026-10-20T12:00:00Z"));
  assert.deepEqual(db.publishClosedDays(new Date("2026-10-20T14:59:59Z")), []);
  assert.deepEqual(db.publishClosedDays(new Date("2026-10-20T15:00:01Z")),
    [{ date: "2026-10-20", existed: false, cells: 0 }]);
  assert.equal(db.latestState().date, "2026-10-20");
  db.close();
});

test("server-side event N is applied and cannot change after publication", () => {
  const db = new Store();
  db.initialize(new Date("2026-10-20T12:00:00Z"));
  db.createUser("user-1");
  db.setPostStrength("2026-10-20", 3);
  db.submit("user-1", "2026-10-20", 0, 0, "A");
  const result = db.publishDay("2026-10-20").state;
  assert.deepEqual(result.cells.find((c) => c.x === 1 && c.y === 0),
    { x: 1, y: 0, char: "A", n: 2 });
  assert.throws(() => db.setPostStrength("2026-10-20", 4), /immutable/);
  db.close();
});

test("passkey counter uses compare-and-swap", () => {
  const db = new Store();
  db.createUser("user-1");
  db.registerCredential("user-1",
    { id: "credential-1", publicKey: new Uint8Array([1, 2]), counter: 0 });
  assert.deepEqual([...db.credentialById("credential-1").publicKey], [1, 2]);
  db.updateCounter("credential-1", 0, 1);
  assert.throws(() => db.updateCounter("credential-1", 0, 1), /raced/);
  db.close();
});

test("challenge is one-use and sessions are revocable", () => {
  const db = new Store();
  const digest = createHash("sha256").update(randomBytes(32)).digest("hex");
  db.issueChallenge(digest, "register", "challenge-with-at-least-thirty-two-characters", "user-1");
  assert.equal(db.consumeChallenge(digest, "register").userId, "user-1");
  assert.equal(db.consumeChallenge(digest, "register"), null);
  db.createUser("user-1");
  db.issueSession(digest, "user-1");
  assert.equal(db.userForSession(digest), "user-1");
  db.revokeSession(digest);
  assert.equal(db.userForSession(digest), null);
  db.close();
});

test("SQLite database persists on disk", async () => {
  const folder = await mkdtemp(join(tmpdir(), "erosion-map-"));
  try {
    const path = join(folder, "test.sqlite");
    const db = new Store(path);
    db.initialize(new Date("2026-10-20T12:00:00Z"));
    db.close();
    const reopened = new Store(path);
    assert.equal(reopened.latestState().date, "2026-10-19");
    assert.equal(reopened.days().length, 1);
    reopened.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
