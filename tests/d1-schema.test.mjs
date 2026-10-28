import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("the hosted D1-compatible schema creates the required constraints on SQLite", async () => {
  const sql = await readFile("migrations/0001_d1_schema.sql", "utf8");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(sql);
    const expected = new Set([
      "users", "passkeys", "challenges", "sessions",
      "posts", "day_config", "site_settings", "snapshots",
    ]);
    const actual = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(row=>row.name));
    assert.deepEqual(actual,expected);

    db.prepare("INSERT INTO users(id,created_at) VALUES(?,?)").run("u1",0);
    db.prepare("INSERT INTO posts(user_id,day,revision,x,y,char,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run("u1","2026-10-28",1,0,0,"海",0);
    assert.throws(()=>db.prepare(
      "INSERT INTO posts(user_id,day,revision,x,y,char,updated_at) VALUES(?,?,?,?,?,?,?)"
    ).run("u1","2026-10-28",1,0,1,"星",0),/UNIQUE/);
    db.prepare("DELETE FROM users WHERE id=?").run("u1");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM posts").get().count,0);
    assert.throws(()=>db.prepare(
      "INSERT INTO day_config(day,post_strength,same_glyph_mode,min_outbound) VALUES(?,?,?,?)"
    ).run("2026-10-29",1,"unknown",1),/CHECK/);
    db.exec(sql); // CREATE IF NOT EXISTS must be safely reentrant.
  } finally {
    db.close();
  }
});

test("closure capture migration backfills old sealed posts and freezes new ones", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(await readFile("migrations/0001_d1_schema.sql", "utf8"));
    db.exec(await readFile("migrations/0002_day_closure.sql", "utf8"));
    const insertUser = db.prepare("INSERT INTO users(id,created_at) VALUES(?,?)");
    const insertPost = db.prepare(
      "INSERT INTO posts(user_id,day,revision,x,y,char,updated_at) VALUES(?,?,?,?,?,?,?)"
    );
    const seal = db.prepare(
      "INSERT INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) " +
      "VALUES(?,?,?,?,?)"
    );
    insertUser.run("user-1", 1);
    insertPost.run("user-1", "2026-10-20", 2, 1, 3, "海", 1);
    seal.run("2026-10-20", "{}", 1, "a".repeat(64), 2);
    const migrate = await readFile("migrations/0003_closed_post_capture.sql", "utf8");
    db.exec(migrate);
    const captured = () => db.prepare(
      "SELECT day,post_order,revision,x,y,char FROM closed_posts ORDER BY day,post_order"
    ).all();
    assert.deepEqual(captured().map(x => [x.day, x.post_order, x.char]),
      [["2026-10-20", 1, "海"]]);
    db.exec(migrate);
    assert.equal(captured().length, 1, "migration is idempotent");
    insertUser.run("user-2", 3);
    insertPost.run("user-2", "2026-10-21", 1, -2, 5, "山", 3);
    seal.run("2026-10-21", "{}", 2, "b".repeat(64), 4);
    db.prepare("DELETE FROM users WHERE id=?").run("user-1");
    db.prepare("DELETE FROM users WHERE id=?").run("user-2");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts").get().n, 0);
    assert.deepEqual(captured().map(x => [x.day, x.post_order, x.char]),
      [["2026-10-20", 1, "海"], ["2026-10-21", 1, "山"]]);
  } finally { db.close(); }
});
