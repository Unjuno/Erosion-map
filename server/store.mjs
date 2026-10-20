/**
 * SQLite development adapter. Experimental node:sqlite, not a GPT Sites adapter.
 * Public submissions must be authorized by a verified passkey session.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { buildDailySnapshot } from "../dist/daily.js";
import { boundsForUserCount, normalizeGlyph } from "../dist/engine.js";
import { assertIsoDay, dayAtInstant, nextIsoDay } from "../dist/calendar.js";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const nowMs = () => Date.now();

function previousDay(day) {
  assertIsoDay(day);
  return new Date(Date.parse(day + "T00:00:00.000Z") - 86_400_000)
    .toISOString().slice(0, 10);
}
function checkToken(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    throw new RangeError("invalid token digest");
  }
}
function checkUserID(userId) {
  if (typeof userId !== "string" ||
      !/^[A-Za-z0-9._~-]{1,128}$/.test(userId)) {
    throw new RangeError("invalid user ID");
  }
}

export class Store {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS passkeys (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0 CHECK(counter>=0), transports_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;",
      "CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);",
      "CREATE TABLE IF NOT EXISTS challenges (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('register','authenticate')), challenge TEXT NOT NULL, user_id TEXT, expires_at INTEGER NOT NULL) STRICT;",
      "CREATE INDEX IF NOT EXISTS idx_challenges_exp ON challenges(expires_at);",
      "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL) STRICT;",
      "CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);",
      "CREATE TABLE IF NOT EXISTS posts (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), x INTEGER NOT NULL, y INTEGER NOT NULL, char TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,day)) STRICT;",
      "CREATE INDEX IF NOT EXISTS idx_posts_day ON posts(day);",
      "CREATE TABLE IF NOT EXISTS day_config (day TEXT PRIMARY KEY, post_strength INTEGER NOT NULL CHECK(post_strength>=1)) STRICT;",
      "CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, state_json TEXT NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;",
    ].join("\n"));
  }
  close() { this.db.close(); }
  usersCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS total FROM users").get().total);
  }
  createUser(userId = randomUUID()) {
    checkUserID(userId);
    this.db.prepare("INSERT INTO users(id,created_at) VALUES(?,?)")
      .run(userId, nowMs());
    return userId;
  }
  hasUser(userId) {
    checkUserID(userId);
    return this.db.prepare("SELECT 1 FROM users WHERE id=?").get(userId) !== undefined;
  }
  registerCredential(userId, credential, createUser = false) {
    checkUserID(userId);
    if (typeof credential.id !== "string" || credential.id.length < 1 ||
        !(credential.publicKey instanceof Uint8Array) ||
        !Number.isSafeInteger(credential.counter) || credential.counter < 0) {
      throw new RangeError("invalid credential data");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (createUser) this.createUser(userId);
      else if (!this.hasUser(userId)) throw new RangeError("user not found");
      this.db.prepare("INSERT INTO passkeys(credential_id,user_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(credential.id, userId, Buffer.from(credential.publicKey),
          credential.counter, JSON.stringify(credential.transports ?? []), nowMs());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  credentialById(id) {
    if (typeof id !== "string" || id.length < 1 || id.length > 2048) return null;
    const row = this.db.prepare(
      "SELECT credential_id AS id,user_id AS userId,public_key AS publicKey,counter,transports_json AS transportsJson FROM passkeys WHERE credential_id=?"
    ).get(id);
    if (!row) return null;
    return {
      id: row.id, userId: row.userId,
      publicKey: new Uint8Array(row.publicKey),
      counter: Number(row.counter), transports: JSON.parse(row.transportsJson),
    };
  }
  credentialsByUser(userId) {
    checkUserID(userId);
    const rows = this.db.prepare(
      "SELECT credential_id AS id,user_id AS userId,public_key AS publicKey,counter,transports_json AS transportsJson FROM passkeys WHERE user_id=? ORDER BY created_at"
    ).all(userId);
    return rows.map((row) => ({
      id: row.id, userId: row.userId, publicKey: new Uint8Array(row.publicKey),
      counter: Number(row.counter), transports: JSON.parse(row.transportsJson),
    }));
  }
  updateCounter(id, previousCounter, nextCounter) {
    for (const value of [previousCounter, nextCounter]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid counter");
    }
    const changed = this.db.prepare(
      "UPDATE passkeys SET counter=? WHERE credential_id=? AND counter=?"
    ).run(nextCounter, id, previousCounter);
    if (changed.changes !== 1) throw new Error("passkey counter raced or credential missing");
  }
  issueChallenge(tokenHash, kind, challenge, userId = null, ttlMs = 300_000) {
    checkToken(tokenHash);
    if (userId !== null) checkUserID(userId);
    if (!["register", "authenticate"].includes(kind) ||
        typeof challenge !== "string" || challenge.length < 32 ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) {
      throw new RangeError("invalid challenge");
    }
    this.db.prepare("INSERT INTO challenges(token_hash,kind,challenge,user_id,expires_at) VALUES(?,?,?,?,?)")
      .run(tokenHash, kind, challenge, userId, nowMs() + ttlMs);
  }
  consumeChallenge(tokenHash, kind) {
    checkToken(tokenHash);
    const row = this.db.prepare(
      "DELETE FROM challenges WHERE token_hash=? RETURNING kind,challenge,user_id AS userId,expires_at AS expiresAt"
    ).get(tokenHash);
    if (!row || row.kind !== kind || row.expiresAt <= nowMs()) return null;
    return row;
  }
  issueSession(tokenHash, userId, ttlMs = 7 * 24 * 60 * 60_000) {
    checkToken(tokenHash);
    checkUserID(userId);
    this.db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(tokenHash, userId, nowMs() + ttlMs);
  }
  userForSession(tokenHash) {
    if (typeof tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
    const row = this.db.prepare(
      "SELECT user_id AS userId,expires_at AS expiresAt FROM sessions WHERE token_hash=?"
    ).get(tokenHash);
    return row && row.expiresAt > nowMs() ? row.userId : null;
  }
  revokeSession(tokenHash) {
    if (typeof tokenHash === "string" && /^[0-9a-f]{64}$/.test(tokenHash)) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
    }
  }
  pruneExpirations() {
    const time = nowMs();
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(time);
    this.db.prepare("DELETE FROM challenges WHERE expires_at<=?").run(time);
  }
  latestState() {
    const row = this.db.prepare(
      "SELECT state_json FROM snapshots ORDER BY day DESC LIMIT 1"
    ).get();
    return row ? JSON.parse(row.state_json) : null;
  }
  snapshot(day) {
    assertIsoDay(day);
    const row = this.db.prepare(
      "SELECT state_json,sha256 FROM snapshots WHERE day=?"
    ).get(day);
    return row ? { state: JSON.parse(row.state_json), sha256: row.sha256 } : null;
  }
  days(limit = 90) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3650) {
      throw new RangeError("invalid date listing limit");
    }
    return this.db.prepare(
      "SELECT day,sha256 FROM snapshots ORDER BY day DESC LIMIT ?"
    ).all(limit);
  }
  initialize(instant = new Date()) {
    const existing = this.latestState();
    if (existing) return existing;
    const day = previousDay(dayAtInstant(instant));
    const state = { date: day, bounds: boundsForUserCount(this.usersCount()), cells: [] };
    const encoded = JSON.stringify(state);
    this.db.prepare("INSERT INTO snapshots(day,state_json,sha256,created_at) VALUES(?,?,?,?)")
      .run(day, encoded, sha(encoded), nowMs());
    return state;
  }
  postStrength(day) {
    assertIsoDay(day);
    const row = this.db.prepare(
      "SELECT post_strength AS strength FROM day_config WHERE day=?"
    ).get(day);
    return row ? Number(row.strength) : 1;
  }
  /** Trusted operator-only method; never expose this on public routes. */
  setPostStrength(day, n) {
    assertIsoDay(day);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100) {
      throw new RangeError("event N must be an integer 1..100");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.snapshot(day)) throw new Error("published day is immutable");
      this.db.prepare(
        "INSERT INTO day_config(day,post_strength) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET post_strength=excluded.post_strength"
      ).run(day, n);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Atomic final daily post. Caller MUST already be authenticated. */
  submit(userId, day, x, y, char) {
    checkUserID(userId);
    assertIsoDay(day);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      throw new RangeError("coordinates must be safe integers");
    }
    const normalized = normalizeGlyph(char);
    const b = boundsForUserCount(this.usersCount());
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) {
      throw new RangeError("post lies outside map bounds");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.snapshot(day)) throw new Error("submissions are closed for the published day");
      const row = this.db.prepare(
        "INSERT INTO posts(user_id,day,revision,x,y,char,updated_at) " +
        "VALUES(?,?,1,?,?,?,?) " +
        "ON CONFLICT(user_id,day) DO UPDATE SET revision=posts.revision+1, " +
        "x=excluded.x, y=excluded.y, char=excluded.char, updated_at=excluded.updated_at " +
        "RETURNING revision"
      ).get(userId, day, x, y, normalized, nowMs());
      this.db.exec("COMMIT");
      return { revision: Number(row.revision), day, x, y, char: normalized };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  currentPost(userId, day) {
    checkUserID(userId);
    assertIsoDay(day);
    return this.db.prepare(
      "SELECT day,revision,x,y,char FROM posts WHERE user_id=? AND day=?"
    ).get(userId, day) ?? null;
  }
  dailyPosts(day) {
    assertIsoDay(day);
    return this.db.prepare(
      "SELECT user_id AS userId,day AS date,revision,x,y,char FROM posts WHERE day=? ORDER BY user_id"
    ).all(day);
  }
  /** Serializable state publication. Any completed date is immutable. */
  publishDay(day) {
    assertIsoDay(day);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const latest = this.latestState();
      if (!latest) throw new Error("database is not initialized");
      const already = this.snapshot(day);
      if (already) {
        this.db.exec("COMMIT");
        return { state: already.state, existed: true };
      }
      if (nextIsoDay(latest.date) !== day) {
        throw new RangeError("cannot skip days or publish out of order");
      }
      const next = buildDailySnapshot(latest, this.dailyPosts(day), {
        date: day, postStrength: this.postStrength(day),
        registeredUserCount: this.usersCount(),
      });
      const encoded = JSON.stringify(next);
      this.db.prepare("INSERT INTO snapshots(day,state_json,sha256,created_at) VALUES(?,?,?,?)")
        .run(day, encoded, sha(encoded), nowMs());
      this.db.exec("COMMIT");
      return { state: next, existed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Run after midnight JST. Never finalize today's open submissions. */
  publishClosedDays(instant = new Date(), maxDays = 366) {
    if (!Number.isSafeInteger(maxDays) || maxDays < 1 || maxDays > 366) {
      throw new RangeError("maxDays must be 1..366");
    }
    const today = dayAtInstant(instant);
    let snapshot = this.latestState();
    if (!snapshot) snapshot = this.initialize(instant);
    const result = [];
    for (let index = 0; index < maxDays; index++) {
      const next = nextIsoDay(snapshot.date);
      if (next >= today) break;
      const generation = this.publishDay(next);
      snapshot = generation.state;
      result.push({ date: next, existed: generation.existed, cells: snapshot.cells.length });
    }
    return result;
  }
}
