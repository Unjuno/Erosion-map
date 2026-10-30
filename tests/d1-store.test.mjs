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
  sqlite.exec(await readFile("migrations/0005_durable_rate_limits.sql", "utf8"));
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

test("D1 recovers a post accepted before the first snapshot after a delayed start", async () => {
  const f = await makeFixture(new Date("2026-10-23T00:00:00Z"));
  try {
    await f.store.registerCredential("player", {
      id: "key", publicKey: new Uint8Array([1]), counter: 0,
    }, true);
    await f.store.submit("player", "2026-10-20", 0, 0, "光");
    await f.store.publishClosedDays();
    const published = await f.store.snapshot("2026-10-20");
    assert.ok(published?.state.cells.some((cell) => cell.char === "光"));
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
    const other = "b" + "\u035c".repeat(31);
    const previous = {
      date: "2026-10-19",
      bounds: { minX: -250, maxX: 249, minY: -250, maxY: 249 },
      cells: Array.from({ length: 21_000 }, (_, i) => ({
        x: i % 200, y: Math.floor(i / 200),
        // Alternating glyphs along each column prevent RLE compression,
        // exercising the existing chunk fallback on >2MB JSON.
        char: Math.floor(i / 200) % 2 === 0 ? glyph : other, n: 1,
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
        sameGlyphMode: "max", minimumOutgoingInfluence: 0,
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

test("D1 rate limits are atomic, bounded and expiring", async () => {
  const instant = new Date("2026-10-22T00:00:00Z");
  const f = await makeFixture(instant);
  try {
    const results = await Promise.all(Array.from({ length: 9 }, () =>
      f.store.allowRate("auth-global", "single-test-client", 3, 300_000)));
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(results.filter((allowed) => !allowed).length, 6);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n, 1);
    instant.setTime(instant.getTime() + 301_000);
    await f.store.pruneExpirations();
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM rate_limits").get().n, 0);
    assert.equal(await f.store.allowRate("auth-global", "single-test-client", 3, 300_000), true);
  } finally { f.close(); }
});

test("large same-glyph snapshots are stored losslessly with small column runs", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00.000Z"));
    // 60k cells, more than 2MB uncompressed, but each x-column is one run.
    const previous = {
      date: "2026-10-19",
      bounds: { minX: -250, maxX: 249, minY: -250, maxY: 249 },
      cells: Array.from({ length: 60_000 }, (_, i) => ({
        x: i % 250, y: Math.floor(i / 250), char: "森", n: 1,
      })),
    };
    const digest = await hashText(JSON.stringify(previous));
    const actualSnapshot = f.store.snapshot.bind(f.store);
    f.store.latestState = async () => previous;
    f.store.snapshot = async (day) => day === previous.date
      ? { state: previous, sha256: digest } : actualSnapshot(day);
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "max", minimumOutgoingInfluence: 0,
      }));
    const published = await f.store.publishDay("2026-10-20");
    const original = JSON.stringify(published.state);
    assert.ok(Buffer.byteLength(original, "utf8") > 2_000_000);
    const stored = f.sqlite.prepare(
      "SELECT state_json AS data FROM snapshots WHERE day=?"
    ).get("2026-10-20").data;
    assert.match(stored, /^@rle-snapshot:v1:/);
    assert.ok(Buffer.byteLength(stored, "utf8") < Buffer.byteLength(original, "utf8") / 20);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM snapshot_chunks WHERE day=?"
    ).get("2026-10-20").n, 0);
    const read = await f.store.snapshot("2026-10-20");
    assert.deepEqual(read.state, published.state);
    assert.equal(read.sha256, await hashText(original));
    f.sqlite.prepare(
      "UPDATE snapshots SET state_json=? WHERE day=?"
    ).run("@rle-snapshot:v1:{\"date\":\"2026-10-20\",\"bounds\":{},\"runs\":[[0,0,999999999,\"森\",1]]}", "2026-10-20");
    await assert.rejects(() => f.store.snapshot("2026-10-20"), /RLE/);
  } finally { f.close(); }
});



test("authenticated updates use persisted public bounds instead of decoding the entire map", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("bounds-player", {
      id: "key-bounds", publicKey: new Uint8Array([1, 2, 3]), counter: 0,
    }, true);
    await f.store.run("INSERT INTO site_settings(key,value) VALUES(?,?)",
      "receiver_default", JSON.stringify({
        sameGlyphMode: "max", minimumOutgoingInfluence: 1,
      }));
    await f.store.submit("bounds-player", "2026-10-20", 0, 0, "海");
    await f.store.publishDay("2026-10-20");
    assert.ok(await f.store.first(
      "SELECT value FROM site_settings WHERE key='published_bounds'"
    ));
    const seen = [];
    const originalPrepare = f.db.prepare.bind(f.db);
    f.db.prepare = sql => {
      seen.push(sql);
      return originalPrepare(sql);
    };
    const newPost = await f.store.submit("bounds-player",
      "2026-10-22", 3, 4, "森");
    assert.equal(newPost.revision, 1);
    assert.ok(!seen.some(sql => /SELECT .*state_json/i.test(sql)),
      "the normal posting path must not load the full published map");
  } finally { f.close(); }
});

test("cached published bounds remain monotonic after user count shrinks", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("expanded-player", {
      id: "key-expanded", publicKey: new Uint8Array([7]), counter: 0,
    }, true);
    const bounds = { minX: -300, maxX: 299, minY: -300, maxY: 299 };
    await f.store.run(
      "INSERT INTO site_settings(key,value) VALUES(?,?)", "published_bounds",
      JSON.stringify(bounds)
    );
    const posted = await f.store.submit("expanded-player", "2026-10-22", 299, 299, "木");
    assert.deepEqual([posted.x, posted.y], [299, 299]);
    await assert.rejects(() => f.store.submit(
      "expanded-player", "2026-10-22", 301, 0, "木"), /outside/);
  } finally { f.close(); }
});


test("a late competing publisher cannot rewind bounds after a newer day expands", async () => {
  const f = await makeFixture(new Date("2026-10-23T00:00:00.000Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    const originalBatch = f.db.batch.bind(f.db);
    let releaseStale;
    let markPaused;
    const suspended = new Promise(resolve => { releaseStale = resolve; });
    const paused = new Promise(resolve => { markPaused = resolve; });
    let intercepted = false;
    f.db.batch = async (statements) => {
      if (!intercepted && statements.some(item =>
        item.sql.includes("INSERT INTO day_config") &&
        item.parameters?.[0] === "2026-10-20")) {
        intercepted = true;
        markPaused();
        await suspended;
      }
      return originalBatch(statements);
    };

    const stale = f.store.publishDay("2026-10-20");
    await paused;
    const competing = new D1Store(f.db, {
      clock: () => new Date("2026-10-23T00:00:00Z"),
      rulesDefault: { sameGlyphMode: "max", minimumOutgoingInfluence: 1 },
    });
    await competing.publishDay("2026-10-20");
    // User growth on day two expands 500x500 to 502x502.
    f.sqlite.exec(
      "WITH RECURSIVE user_num(n) AS (" +
      "SELECT 1 UNION ALL SELECT n+1 FROM user_num WHERE n<502) " +
      "INSERT INTO users(id,created_at) " +
      "SELECT 'registration-' || n,1 FROM user_num"
    );
    await competing.publishDay("2026-10-21");
    const before = await competing.publishedBounds();
    assert.equal(before.maxX, 250);
    releaseStale();
    const lateResult = await stale;
    assert.equal(lateResult.existed, true);
    assert.deepEqual(await competing.publishedBounds(), before,
      "stale publication must never overwrite newer published bounds");
  } finally { f.close(); }
});

test("missing closure capture must stop publication before any accepted post is erased", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("poster", {
      id: "closure-guard-key", publicKey: new Uint8Array([7]), counter: 0,
    }, true);
    await f.store.submit("poster", "2026-10-20", 0, 0, "星");
    // Deliberate fault injection: simulate a damaged D1 trigger installation.
    f.sqlite.exec("DROP TRIGGER capture_closed_day_posts");
    await assert.rejects(() => f.store.publishDay("2026-10-20"),
      /capture|frozen|integrity|inconsisten/i);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE day='2026-10-20'"
    ).get().n, 1, "the accepted post must remain available for recovery");
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM snapshots WHERE day='2026-10-20'"
    ).get().n, 0, "a broken capture cannot be silently published as an empty day");
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM day_closures WHERE day='2026-10-20'"
    ).get().n, 0, "no new closure is created while its capture trigger is missing");
  } finally { f.close(); }
});


test("a present but broken capture trigger cannot silently discard accepted posts", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("poster", {
      id: "broken-trigger-key", publicKey: new Uint8Array([7]), counter: 0,
    }, true);
    await f.store.submit("poster", "2026-10-20", 0, 0, "月");
    // A no-op trigger bearing the right name mimics partial migration damage.
    f.sqlite.exec(
      "DROP TRIGGER capture_closed_day_posts;" +
      "CREATE TRIGGER capture_closed_day_posts AFTER INSERT ON day_closures " +
      "BEGIN SELECT 1; END;"
    );
    await assert.rejects(() => f.store.publishDay("2026-10-20"), /capture integrity mismatch/);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE day='2026-10-20'"
    ).get().n, 1);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM snapshots WHERE day='2026-10-20'"
    ).get().n, 0);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM day_closures WHERE day='2026-10-20'"
    ).get().n, 1, "the post remains sealed while operators repair the missing frozen copy");
  } finally { f.close(); }
});


test("an accepted expanded-grid post survives account deletion and later user-count shrink", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("expanded-author", {
      id: "expanded-author-key", publicKey: new Uint8Array([1, 2]), counter: 0,
    }, true);
    // 502 registered users temporarily unlock a grid larger than 500x500.
    f.sqlite.exec(
      "WITH RECURSIVE n(x) AS (" +
      "SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<501) " +
      "INSERT INTO users(id,created_at) SELECT 'expanded-other-' || x,1 FROM n"
    );
    const accepted = await f.store.submit("expanded-author",
      "2026-10-20", 250, 250, "森");
    assert.deepEqual([accepted.x, accepted.y], [250, 250]);
    // Delete the author after midnight, before the daily closure job.
    await f.store.deleteUser("expanded-author");
    f.sqlite.exec("DELETE FROM users WHERE id LIKE 'expanded-other-%'");
    assert.equal(await f.store.usersCount(), 0);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM orphaned_posts WHERE day='2026-10-20'"
    ).get().n, 1);
    const output = await f.store.publishDay("2026-10-20");
    assert.ok(output.state.bounds.maxX >= 250 && output.state.bounds.maxY >= 250,
      "previously accepted coordinates must remain inside the published grid");
    assert.ok(output.state.cells.some(cell =>
      cell.x === 250 && cell.y === 250 && cell.char === "森"));
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM orphaned_posts WHERE day='2026-10-20'"
    ).get().n, 0);
  } finally { f.close(); }
});


test("a deleted account's sealed post remains recoverable after baseline snapshot loss", async () => {
  const f = await makeFixture(new Date("2026-10-23T00:00:00Z"));
  try {
    // Simulate restoration of an incomplete database: a finalized day and
    // anonymous posts survived, but the previously empty baseline did not.
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("survivor", {
      id: "survivor-credential", publicKey: new Uint8Array([1, 7]), counter: 0,
    }, true);
    await f.store.submit("survivor", "2026-10-20", 0, 0, "森");
    const previous = await f.store.snapshot("2026-10-19");
    await f.store.run(
      "INSERT INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) " +
      "VALUES(?,?,?,?,?)",
      "2026-10-20",
      JSON.stringify({ postStrength: 1, sameGlyphMode: "max",
        minimumOutgoingInfluence: 1 }),
      1, previous.sha256, 123
    );
    await f.store.deleteUser("survivor");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM closed_posts").get().n, 1);
    // Fault injection models an incomplete backup/restore, not normal daily use.
    await f.store.run("DELETE FROM snapshots WHERE day=?", "2026-10-19");
    const published = await f.store.publishClosedDays();
    assert.ok(published.some(entry => entry.date === "2026-10-20"));
    const restored = await f.store.snapshot("2026-10-20");
    assert.ok(restored?.state.cells.some(cell =>
      cell.char === "森" && cell.x === 0 && cell.y === 0));
  } finally { f.close(); }
});

test("frozen-post removal after account deletion must never publish an empty day", async () => {
  const f = await makeFixture(new Date("2026-10-22T00:00:00Z"));
  try {
    await f.store.initialize(new Date("2026-10-20T12:00:00Z"));
    await f.store.registerCredential("owner", {
      id: "frozen-integrity-key", publicKey: new Uint8Array([1]), counter: 0,
    }, true);
    await f.store.submit("owner", "2026-10-20", 0, 0, "光");
    const previous = await f.store.snapshot("2026-10-19");
    await f.store.run(
      "INSERT INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) " +
      "VALUES(?,?,?,?,?)",
      "2026-10-20",
      JSON.stringify({ postStrength: 1, sameGlyphMode: "max",
        minimumOutgoingInfluence: 1 }),
      1, previous.sha256, 123
    );
    await f.store.deleteUser("owner");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM closed_posts").get().n, 1);
    // Corrupted database / bad operator action, after the source was deleted.
    await f.store.run("DELETE FROM closed_posts WHERE day=?", "2026-10-20");
    await assert.rejects(() => f.store.publishDay("2026-10-20"),
      /frozen|capture|integrity|mismatch/i);
    assert.equal(f.sqlite.prepare(
      "SELECT COUNT(*) AS n FROM snapshots WHERE day='2026-10-20'"
    ).get().n, 0, "never finalize a silently incomplete public snapshot");
  } finally { f.close(); }
});
