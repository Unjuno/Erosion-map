import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { D1Store, hashText } from "../sites/d1-store.mjs";

/** Minimal D1 API emulation backed by real SQLite for SQL/data-integrity tests. */
async function makeFixture(instant = new Date("2026-10-21T00:00:00.000Z")) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(await readFile("migrations/0001_d1_schema.sql", "utf8"));
  const statement = (sql, parameters = []) => ({
    sql, parameters,
    bind(...next) { return statement(sql, next); },
    async first() {
      return sqlite.prepare(sql).get(...parameters) ?? null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...parameters) };
    },
    async run() {
      const results = sqlite.prepare(sql).run(...parameters);
      return { success: true, meta: { changes: Number(results.changes) } };
    },
  });
  const db = {
    prepare(sql) { return statement(sql); },
    async batch(items) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = [];
        for (const item of items) result.push(await item.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const store = new D1Store(db, { clock: () => instant });
  return { store, db, sqlite, close: () => sqlite.close() };
}

test("D1 schema, initialization and public snapshot checksums", async () => {
  const f = await makeFixture();
  try {
    const s = await f.store.initialize();
    assert.equal(s.date, "2026-10-20");
    assert.equal(s.cells.length, 0);
    const copy = await f.store.snapshot("2026-10-20");
    assert.equal(copy.sha256, await hashText(JSON.stringify(s)));
    assert.equal((await f.store.days()).length, 1);
    assert.deepEqual(await f.store.initialize(), s);
  } finally { f.close(); }
});

test("D1 registration, one-use challenges, sessions and credential deletion", async () => {
  const f = await makeFixture();
  try {
    const id = "abc123-user";
    const key = new Uint8Array([5, 8, 13, 21]);
    await f.store.registerCredential(id, {
      id: "credential", publicKey: key, counter: 0, transports: ["internal"],
    }, true);
    assert.equal(await f.store.usersCount(), 1);
    const found = await f.store.credentialById("credential");
    assert.deepEqual([...found.publicKey], [...key]);
    assert.equal((await f.store.credentialsByUser(id)).length, 1);
    await f.store.updateCounter("credential", 0, 1);
    await assert.rejects(() => f.store.updateCounter("credential", 0, 1), /raced/);
    const token = "a".repeat(64);
    await f.store.issueChallenge(token, "authenticate", "sufficient-length-challenge-string-here");
    assert.equal((await f.store.consumeChallenge(token, "authenticate")).kind, "authenticate");
    assert.equal(await f.store.consumeChallenge(token, "authenticate"), null);
    await f.store.issueSession(token, id);
    assert.equal(await f.store.userForSession(token), id);
    await f.store.revokeSession(token);
    assert.equal(await f.store.userForSession(token), null);
    await f.store.deleteUser(id);
    assert.equal(await f.store.usersCount(), 0);
    assert.equal(await f.store.credentialById("credential"), null);
  } finally { f.close(); }
});

test("D1 final daily edit, max+floor mode and immutable published history", async () => {
  const f = await makeFixture(new Date("2026-10-22T01:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("player", {
      id: "passkey", publicKey: new Uint8Array([1, 2]), counter: 0,
    }, true);
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "max", minimumOutgoingInfluence: 1,
      }));
    const first = await f.store.submit("player", "2026-10-20", 0, 0, "光");
    const second = await f.store.submit("player", "2026-10-20", 1, 0, "星");
    assert.deepEqual([first.revision, second.revision], [1, 2]);
    assert.equal((await f.store.dailyPosts("2026-10-20")).length, 1);
    const published = await f.store.publishDay("2026-10-20");
    assert.equal(published.existed, false);
    assert.equal(published.state.cells.length, 5);
    assert.equal((await f.store.snapshot("2026-10-20")).state.cells.length, 5);
    assert.equal((await f.store.publishDay("2026-10-20")).existed, true);
    await assert.rejects(
      () => f.store.submit("player", "2026-10-20", 10, 10, "海"),
      /already published/
    );
    assert.equal((await f.store.dayRules("2026-10-20")).sameGlyphMode, "max");
  } finally { f.close(); }
});

test("D1 scheduler does not publish an open JST day", async () => {
  const f = await makeFixture(new Date("2026-10-20T14:59:59Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    assert.deepEqual(await f.store.publishClosedDays(), []);
    await assert.rejects(
      () => f.store.publishDay("2026-10-20"),
      /open day/
    );
  } finally { f.close(); }
});

test("D1 snapshot corruption is detected before serving", async () => {
  const f = await makeFixture();
  try {
    await f.store.initialize();
    await f.store.run("UPDATE snapshots SET sha256='0' WHERE day=?", "2026-10-20");
    await assert.rejects(() => f.store.snapshot("2026-10-20"), /checksum/);
    await assert.rejects(() => f.store.latestState(), /checksum/);
  } finally { f.close(); }
});
