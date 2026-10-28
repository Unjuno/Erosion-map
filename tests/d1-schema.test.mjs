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
