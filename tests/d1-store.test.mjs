import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { D1Store, hashText } from "../sites/d1-store.mjs";

/** Minimal D1 API emulation backed by real SQLite for SQL/data-integrity tests. */
async function makeFixture(instant = new Date("2026-10-21T00:00:00.000Z"), options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  sqlite.exec(await readFile("migrations/0001_d1_schema.sql", "utf8"));
  sqlite.exec(await readFile("migrations/0002_day_closure.sql", "utf8"));
  sqlite.exec(await readFile("migrations/0003_closed_post_capture.sql", "utf8"));
  sqlite.exec(await readFile("migrations/0004_archival_and_chunked_states.sql", "utf8"));
  const adapt = (parameters) => parameters.map((parameter) =>
    parameter instanceof ArrayBuffer ? new Uint8Array(parameter) : parameter);
  const asD1 = (row) => {
    if (!options.blobArrays || !row) return row;
    return row.publicKey instanceof Uint8Array
      ? { ...row, publicKey: Array.from(row.publicKey) } : row;
  };
  const statement = (sql, parameters = []) => ({
    sql, parameters,
    bind(...next) { return statement(sql, next); },
    async first() {
      return asD1(sqlite.prepare(sql).get(...adapt(parameters)) ?? null);
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...adapt(parameters)).map(asD1) };
    },
    async run() {
      const results = sqlite.prepare(sql).run(...adapt(parameters));
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


test("D1 resumes missed days in sequence and remains idempotent", async () => {
  const f = await makeFixture(new Date("2026-10-23T00:30:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    await f.store.registerCredential("owner", {
      id: "key", publicKey: new Uint8Array([10, 20]), counter: 0,
    }, true);
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "max", minimumOutgoingInfluence: 1,
      }));
    await f.store.submit("owner", "2026-10-20", 0, 0, "月");
    const first = await f.store.publishClosedDays();
    assert.deepEqual(first.map((record) => record.date),
      ["2026-10-20", "2026-10-21", "2026-10-22"]);
    assert.equal(first[0].cells, 5);
    const final = await f.store.latestState();
    assert.equal(final.date, "2026-10-22");
    assert.ok(final.cells.length > 5);
    assert.deepEqual(await f.store.publishClosedDays(), []);
    const existing = await f.store.publishDay("2026-10-20");
    assert.equal(existing.existed, true);
  } finally { f.close(); }
});

test("D1 freezes effective daily rules and keeps the original day config", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    await f.store.run(
      "INSERT INTO day_config(day,post_strength,same_glyph_mode,min_outbound,rule_override) VALUES(?,?,?,?,1)",
      "2026-10-20", 3, "max", 1
    );
    const recorded = await f.store.publishDay("2026-10-20");
    assert.equal(recorded.existed, false);
    assert.deepEqual(await f.store.dayRules("2026-10-20"), {
      postStrength: 3, sameGlyphMode: "max", minimumOutgoingInfluence: 1,
    });
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "sum", minimumOutgoingInfluence: 0,
      }));
    assert.equal((await f.store.dayRules("2026-10-20")).sameGlyphMode, "max");
  } finally { f.close(); }
});


test("day closure freezes incoming posts before daily calculation", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("player", {
      id: "passkey-1", publicKey: new Uint8Array([1, 2]), counter: 0,
    }, true);
    await f.store.submit("player", "2026-10-20", 0, 0, "星");
    const previous = await f.store.snapshot("2026-10-19");
    await f.store.run(
      "INSERT INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) VALUES(?,?,?,?,?)",
      "2026-10-20",
      JSON.stringify({ postStrength: 1, sameGlyphMode: "max",
        minimumOutgoingInfluence: 1 }),
      1, previous.sha256, Date.now()
    );
    await assert.rejects(() =>
      f.store.submit("player", "2026-10-20", 5, 5, "月"), /sealed/);
    const published = await f.store.publishDay("2026-10-20");
    assert.equal(published.state.cells.length, 5);
    assert.deepEqual(await f.store.dailyPosts("2026-10-20"), [],
      "published day no longer stores identifying user posts");
    assert.equal((await f.store.dayRules("2026-10-20")).sameGlyphMode, "max");
  } finally { f.close(); }
});

test("SQL triggers block writes even when the client did not check closure", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("player", {
      id: "key", publicKey: new Uint8Array([7]), counter: 0,
    }, true);
    await f.store.submit("player", "2026-10-20", 0, 0, "A");
    const previous = await f.store.snapshot("2026-10-19");
    await f.store.run(
      "INSERT INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) VALUES(?,?,?,?,?)",
      "2026-10-20", "{}", 1, previous.sha256, Date.now()
    );
    await assert.rejects(() => f.store.run(
      "UPDATE posts SET char='B' WHERE user_id=? AND day=?", "player", "2026-10-20"
    ), /sealed/);
    await assert.rejects(() => f.store.run(
      "INSERT INTO posts(user_id,day,revision,x,y,char,updated_at) VALUES(?,?,?,?,?,?,?)",
      "player", "2026-10-20", 2, 1, 1, "B", Date.now()
    ), /sealed|UNIQUE/);
  } finally { f.close(); }
});

test("sealed day survives account deletion; anonymous captured rows are purged on publish", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    await f.store.registerCredential("player-one", {
      id: "key-one", publicKey: new Uint8Array([1, 2, 3]), counter: 0,
    }, true);
    await f.store.submit("player-one", "2026-10-20", 0, 0, "星");
    const previous = await f.store.snapshot("2026-10-19");
    await f.store.run(
      "INSERT INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) VALUES(?,?,?,?,?)",
      "2026-10-20",
      JSON.stringify({ postStrength: 1, sameGlyphMode: "max",
        minimumOutgoingInfluence: 1 }),
      1, previous.sha256, Date.now()
    );
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM closed_posts").get().n, 1);
    assert.deepEqual(
      f.sqlite.prepare("PRAGMA table_info(closed_posts)").all().map(row => row.name),
      ["day", "post_order", "revision", "x", "y", "char"],
      "captured state cannot retain user identifiers"
    );
    await f.store.deleteUser("player-one");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM closed_posts").get().n, 1);
    const result = await f.store.publishDay("2026-10-20");
    assert.equal(result.existed, false);
    assert.equal(result.state.cells.length, 5);
    assert.ok(result.state.cells.every(cell => cell.char === "星"));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM closed_posts").get().n, 0);
    const replay = await f.store.publishDay("2026-10-20");
    assert.equal(replay.existed, true);
    assert.deepEqual(replay.state, result.state);
  } finally { f.close(); }
});

test("native D1 numeric-array BLOB reads support passkeys and reject bad encodings", async () => {
  const f = await makeFixture(undefined, { blobArrays: true });
  try {
    const bytes = new Uint8Array([0, 128, 255, 17, 42]);
    await f.store.registerCredential("blob-player", {
      id: "d1-credential", publicKey: bytes, counter: 1,
      transports: ["internal"],
    }, true);
    const found = await f.store.credentialById("d1-credential");
    assert.deepEqual([...found.publicKey], [...bytes]);
    assert.deepEqual((await f.store.credentialsByUser("blob-player"))
      .map((item) => [...item.publicKey]), [[...bytes]]);
  } finally { f.close(); }
});

test("account deletion before an overdue day is sealed preserves anonymous final posts", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    for (const [user, id, char, x] of [
      ["deleted-player", "key-delete", "光", 0],
      ["remaining-player", "key-remain", "星", 20],
    ]) {
      await f.store.registerCredential(user, {
        id, publicKey: new Uint8Array([10, 20]), counter: 0,
      }, true);
      await f.store.submit(user, "2026-10-20", x, 0, char);
    }
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "max", minimumOutgoingInfluence: 1,
      }));
    // 2026-10-20 is already closed by JST date, but no closure INSERT ran.
    await f.store.deleteUser("deleted-player");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM orphaned_posts").get().n, 1);
    const columns = f.sqlite.prepare("PRAGMA table_info(orphaned_posts)")
      .all().map((row) => row.name);
    assert.ok(!columns.includes("user_id"));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 1);
    const result = await f.store.publishDay("2026-10-20");
    assert.equal(result.state.cells.length, 10);
    assert.ok(result.state.cells.some(cell => cell.char === "光" && cell.x === 0));
    assert.ok(result.state.cells.some(cell => cell.char === "星" && cell.x === 20));
    for (const table of ["posts", "orphaned_posts", "closed_posts"]) {
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM " + table).get().n, 0,
        table + " must be purged after publication");
    }
    assert.equal((await f.store.publishDay("2026-10-20")).existed, true);
  } finally { f.close(); }
});

test("deleting today's account does not preserve its still-editable post", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    await f.store.registerCredential("today-player", {
      id: "key-today", publicKey: new Uint8Array([7]), counter: 0,
    }, true);
    await f.store.submit("today-player", "2026-10-22", 0, 0, "水");
    await f.store.deleteUser("today-player");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM orphaned_posts").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
  } finally { f.close(); }
});

test("large Unicode map snapshots are stored in small atomic D1 rows and verified", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    const glyph = "a" + "\u035c".repeat(31); // One long grapheme, maximum accepted length.
    const previous = {
      date: "2026-10-19",
      bounds: { minX: -250, maxX: 249, minY: -250, maxY: 249 },
      cells: Array.from({ length: 21_000 }, (_, i) => ({
        x: i % 200, y: Math.floor(i / 200), char: glyph, n: 1,
      })),
    };
    const initialDigest = await hashText(JSON.stringify(previous));
    // A synthetic large predecessor isolates the new day's D1 write/read
    // path without storing an illegally large predecessor in the fixture.
    const trueSnapshot = f.store.snapshot.bind(f.store);
    f.store.latestState = async () => previous;
    f.store.snapshot = async (day) => day === previous.date
      ? { state: previous, sha256: initialDigest } : trueSnapshot(day);
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "max", minimumOutgoingInfluence: 1,
      }));
    const saved = await f.store.publishDay("2026-10-20");
    assert.ok(Buffer.byteLength(JSON.stringify(saved.state), "utf8") > 2_000_000);
    const marker = f.sqlite.prepare(
      "SELECT state_json AS stateValue FROM snapshots WHERE day=?"
    ).get("2026-10-20").stateValue;
    assert.equal(marker, "@chunked-snapshot:v1");
    const chunks = f.sqlite.prepare(
      "SELECT chunk_data AS data FROM snapshot_chunks WHERE day=? ORDER BY chunk_index"
    ).all("2026-10-20");
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk.data, "utf8") <= 1_280_000,
        "chunk size must remain below D1 2 MB row limit even for non-ASCII text");
    }
    const read = await f.store.snapshot("2026-10-20");
    assert.equal(read.sha256, await hashText(JSON.stringify(saved.state)));
    assert.deepEqual(read.state, saved.state);
    f.sqlite.prepare("UPDATE snapshot_chunks SET chunk_data='broken' " +
      "WHERE day=? AND chunk_index=0").run("2026-10-20");
    await assert.rejects(() => f.store.snapshot("2026-10-20"), /checksum/);
  } finally { f.close(); }
});
