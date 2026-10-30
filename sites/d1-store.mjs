/**
 * Asynchronous D1 persistence adapter for ChatGPT Sites-compatible workers.
 *
 * Requires D1 migrations 0001 through 0006 in order.
 * Public routes must authenticate sessions themselves; do not expose
 * createUser, submit, or publishing methods to anonymous calls.
 */
import { buildDailySnapshot } from "../dist/daily.js";
import { boundsForUserCount, normalizeGlyph } from "../dist/engine.js";
import { assertIsoDay, dayAtInstant, nextIsoDay } from "../dist/calendar.js";

const encoder = new TextEncoder();
// D1 limits any single TEXT, BLOB, or table row to 2,000,000 bytes.
// Each stored chunk is at most 320,000 UTF-16 code units, or <=1.28MB UTF-8.
const INLINE_SNAPSHOT_LIMIT = 1_500_000;
const SNAPSHOT_CHUNK_UNITS = 320_000;
const CHUNKED_SNAPSHOT_MARKER = "@chunked-snapshot:v1";

const RLE_SNAPSHOT_MARKER = "@rle-snapshot:v1:";
// Carries an already verified DB SHA without exposing it in public JSON.
const VERIFIED_SNAPSHOT_SHA = Symbol("verified-snapshot-sha");
const MAX_RLE_RUNS = 4096;
const MAX_RLE_DECODED_CELLS = 1_000_000;

/**
 * Lossless storage compression only: a run is (x, first-y, count, glyph, n).
 * Receivers produce cells sorted by x, then y. Runs never cross columns.
 * If a state has too many transitions, use existing full-JSON chunking.
 * The authoritative SHA remains the SHA-256 of the ORIGINAL public JSON.
 */
function encodeSnapshotStorage(snapshot, serialized) {
  if (serialized.length < 300_000 ||
      snapshot.cells.length > MAX_RLE_DECODED_CELLS) return serialized;
  const runs = [];
  let lastCell = null;
  let run = null;
  for (const cell of snapshot.cells) {
    if (lastCell && (cell.x < lastCell.x ||
        (cell.x === lastCell.x && cell.y <= lastCell.y))) {
      return serialized; // Input has no stable canonical order.
    }
    if (run && run[0] === cell.x && run[1] + run[2] === cell.y &&
        run[3] === cell.char && run[4] === cell.n) {
      run[2]++;
    } else {
      if (runs.length >= MAX_RLE_RUNS) return serialized;
      run = [cell.x, cell.y, 1, cell.char, cell.n];
      runs.push(run);
    }
    lastCell = cell;
  }
  const compact = RLE_SNAPSHOT_MARKER + JSON.stringify({
    date: snapshot.date, bounds: snapshot.bounds, runs,
  });
  // Require substantial savings; otherwise no reason to change storage.
  return compact.length * 2 < serialized.length ? compact : serialized;
}

function decodeSnapshotStorage(encoded) {
  if (!encoded.startsWith(RLE_SNAPSHOT_MARKER)) return encoded;
  const packed = JSON.parse(encoded.slice(RLE_SNAPSHOT_MARKER.length));
  if (!packed || !Array.isArray(packed.runs) ||
      packed.runs.length > MAX_RLE_RUNS || !packed.bounds) {
    throw new Error("published snapshot RLE header invalid");
  }
  const cells = [];
  const b = packed.bounds;
  let lastX = null;
  let lastY = null;
  for (const run of packed.runs) {
    if (!Array.isArray(run) || run.length !== 5) {
      throw new Error("published snapshot RLE run invalid");
    }
    const [x, y, length, char, n] = run;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
        !Number.isSafeInteger(length) || length <= 0 ||
        !Number.isSafeInteger(n) || n < 1 ||
        typeof char !== "string" || char.length > 32 ||
        !Number.isSafeInteger(b.minX) || !Number.isSafeInteger(b.maxX) ||
        !Number.isSafeInteger(b.minY) || !Number.isSafeInteger(b.maxY) ||
        x < b.minX || x > b.maxX || y < b.minY ||
        y + length - 1 > b.maxY || y + length - 1 < y ||
        (lastX !== null && (x < lastX || (x === lastX && y <= lastY))) ||
        cells.length + length > MAX_RLE_DECODED_CELLS) {
      throw new Error("published snapshot RLE bounds invalid");
    }
    for (let offset = 0; offset < length; offset++) {
      cells.push({ x, y: y + offset, char, n });
    }
    lastX = x;
    lastY = y + length - 1;
  }
  return JSON.stringify({ date: packed.date, bounds: b, cells });
}


function snapshotParts(serialized) {
  if (encoder.encode(serialized).byteLength <= INLINE_SNAPSHOT_LIMIT) return [];
  const chunks = [];
  for (let index = 0; index < serialized.length;) {
    let end = Math.min(serialized.length, index + SNAPSHOT_CHUNK_UNITS);
    // Do not split a UTF-16 surrogate pair across TEXT rows.
    const codeUnit = serialized.charCodeAt(end - 1);
    if (end < serialized.length && codeUnit >= 0xD800 && codeUnit <= 0xDBFF) end--;
    if (end <= index) throw new Error("failed to split snapshot at Unicode boundary");
    chunks.push(serialized.slice(index, end));
    index = end;
  }
  return chunks;
}
export async function hashText(value) {
  const bytes = encoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function safeUser(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(id)) {
    throw new RangeError("invalid user ID");
  }
}
function safeHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RangeError("invalid token digest");
  }
}
function safeInt(value, name, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(name + " must be an integer >= " + minimum);
  }
}
function previousDay(day) {
  assertIsoDay(day);
  const time = Date.parse(day + "T00:00:00.000Z") - 86_400_000;
  if (!Number.isFinite(time)) throw new RangeError("invalid previous day");
  return new Date(time).toISOString().slice(0, 10);
}
function decodeCredential(row) {
  if (!row) return null;
  let key;
  if (row.publicKey instanceof ArrayBuffer) key = new Uint8Array(row.publicKey);
  else if (row.publicKey instanceof Uint8Array) key = new Uint8Array(row.publicKey);
  else if (Array.isArray(row.publicKey) &&
           row.publicKey.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    // Real D1 returns BLOB columns as number[], unlike Node's SQLite adapter.
    key = Uint8Array.from(row.publicKey);
  } else throw new Error("unexpected passkey key encoding");
  return {
    id: row.id, userId: row.userId, publicKey: key,
    counter: Number(row.counter), transports: JSON.parse(row.transportsJson),
  };
}

/**
 * D1 prepared statements (.bind().first()/all()/run()) only.
 * Cloudflare D1 batch is atomic for grouped writes.
 */
export class D1Store {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      throw new TypeError("a D1 binding with prepare/batch is required");
    }
    this.db = db;
    this.clock = options.clock ?? (() => new Date());
    this.rulesDefault = options.rulesDefault ?? {
      sameGlyphMode: "sum", minimumOutgoingInfluence: 0,
    };
  }
  p(sql, ...params) { return this.db.prepare(sql).bind(...params); }
  async first(sql, ...params) { return this.p(sql, ...params).first(); }
  async all(sql, ...params) {
    const found = await this.p(sql, ...params).all();
    return found.results ?? [];
  }
  async run(sql, ...params) { return this.p(sql, ...params).run(); }
  now() { return this.clock().getTime(); }
  async usersCount() {
    return Number((await this.first("SELECT COUNT(*) AS total FROM users")).total);
  }
  async hasUser(userId) {
    safeUser(userId);
    return !!(await this.first("SELECT 1 AS present FROM users WHERE id=?", userId));
  }
  async registerCredential(userId, credential, newUser = false) {
    safeUser(userId);
    if (!credential || typeof credential.id !== "string" ||
        credential.id.length < 1 || credential.id.length > 2048 ||
        !(credential.publicKey instanceof Uint8Array) ||
        !Number.isSafeInteger(credential.counter) || credential.counter < 0) {
      throw new RangeError("invalid passkey credential");
    }
    const statements = [];
    if (newUser) {
      statements.push(this.p("INSERT INTO users(id,created_at) VALUES(?,?)",
        userId, this.now()));
    } else if (!(await this.hasUser(userId))) {
      throw new RangeError("user not found");
    }
    statements.push(this.p(
      "INSERT INTO passkeys(credential_id,user_id,public_key,counter,transports_json,created_at) VALUES(?,?,?,?,?,?)",
      credential.id, userId, credential.publicKey.buffer.slice(
        credential.publicKey.byteOffset,
        credential.publicKey.byteOffset + credential.publicKey.byteLength
      ), credential.counter,
      JSON.stringify(credential.transports ?? []), this.now()
    ));
    await this.db.batch(statements);
  }
  async credentialById(id) {
    if (typeof id !== "string" || id.length < 1 || id.length > 2048) return null;
    return decodeCredential(await this.first(
      "SELECT credential_id AS id,user_id AS userId,public_key AS publicKey,counter,transports_json AS transportsJson FROM passkeys WHERE credential_id=?",
      id
    ));
  }
  async credentialsByUser(userId) {
    safeUser(userId);
    const rows = await this.all(
      "SELECT credential_id AS id,user_id AS userId,public_key AS publicKey,counter,transports_json AS transportsJson FROM passkeys WHERE user_id=? ORDER BY created_at",
      userId
    );
    return rows.map(decodeCredential);
  }
  async updateCounter(id, previousCounter, nextCounter) {
    safeInt(previousCounter, "previousCounter", 0);
    safeInt(nextCounter, "nextCounter", 0);
    const result = await this.run(
      "UPDATE passkeys SET counter=? WHERE credential_id=? AND counter=?",
      nextCounter, id, previousCounter
    );
    if (result.meta?.changes !== 1) throw new Error("passkey counter raced");
  }
  async deleteUser(userId) {
    safeUser(userId);
    // A calendar day closes at JST midnight, independently of whether
    // the scheduled publisher has run. Preserve past, unsealed final posts
    // without the account ID before ON DELETE CASCADE removes live rows.
    const today = dayAtInstant(this.clock());
    const statements = [
      this.p(
        "INSERT INTO orphaned_posts(day,revision,x,y,char) " +
        "SELECT p.day,p.revision,p.x,p.y,p.char FROM posts AS p " +
        "WHERE p.user_id=? AND p.day<? " +
        "AND NOT EXISTS (SELECT 1 FROM day_closures WHERE day=p.day) " +
        "AND NOT EXISTS (SELECT 1 FROM snapshots WHERE day=p.day)",
        userId, today
      ),
      this.p("DELETE FROM challenges WHERE user_id=?", userId),
      this.p("DELETE FROM users WHERE id=?", userId),
    ];
    const changed = await this.db.batch(statements);
    if (changed[2].meta?.changes !== 1) throw new RangeError("account not found");
  }
  async issueChallenge(tokenHash, kind, challenge, userId = null, ttl = 300_000) {
    safeHash(tokenHash);
    if (userId !== null) safeUser(userId);
    if (!["register", "authenticate"].includes(kind) ||
        typeof challenge !== "string" || challenge.length < 32 ||
        !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300_000) {
      throw new RangeError("invalid challenge");
    }
    await this.run(
      "INSERT INTO challenges(token_hash,kind,challenge,user_id,expires_at) VALUES(?,?,?,?,?)",
      tokenHash, kind, challenge, userId, this.now() + ttl
    );
  }
  async consumeChallenge(tokenHash, kind) {
    safeHash(tokenHash);
    const result = await this.first(
      "DELETE FROM challenges WHERE token_hash=? RETURNING kind,challenge,user_id AS userId,expires_at AS expiresAt",
      tokenHash
    );
    return result && result.kind === kind && result.expiresAt > this.now()
      ? result : null;
  }
  async issueSession(tokenHash, userId, ttlMs = 7 * 86_400_000) {
    safeHash(tokenHash);
    safeUser(userId);
    await this.run(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      tokenHash, userId, this.now() + ttlMs
    );
  }
  async userForSession(tokenHash) {
    if (typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(tokenHash)) return null;
    const row = await this.first(
      "SELECT user_id AS userId,expires_at AS expiresAt FROM sessions WHERE token_hash=?",
      tokenHash
    );
    return row && row.expiresAt > this.now() ? row.userId : null;
  }
  async revokeSession(tokenHash) {
    if (typeof tokenHash === "string" && /^[a-f0-9]{64}$/.test(tokenHash)) {
      await this.run("DELETE FROM sessions WHERE token_hash=?", tokenHash);
    }
  }
  /**
   * Fixed-window rate limiting is atomic at the database, not a worker-local
   * Map. Caller supplies a pseudonymous key, never a raw IP address.
   */
  async allowRate(scope, clientKey, maximum, windowMs = 300_000) {
    if (typeof scope !== "string" || !/^[a-z-]{1,40}$/.test(scope) ||
        typeof clientKey !== "string" || clientKey.length < 1 ||
        clientKey.length > 256) throw new RangeError("invalid rate key");
    safeInt(maximum, "maximum", 1);
    safeInt(windowMs, "windowMs", 1);
    const windowNumber = Math.floor(this.now() / windowMs);
    const bucket = await hashText(scope + ":" + clientKey + ":" + windowNumber);
    const end = (windowNumber + 1) * windowMs;
    const row = await this.first(
      "INSERT INTO rate_limits(bucket_hash,window_end,attempts) VALUES(?,?,1) " +
      "ON CONFLICT(bucket_hash) DO UPDATE SET attempts=rate_limits.attempts+1 " +
      "WHERE rate_limits.attempts<? RETURNING attempts",
      bucket, end, maximum
    );
    return row !== null;
  }
  async pruneExpirations() {
    const now = this.now();
    await this.db.batch([
      this.p("DELETE FROM sessions WHERE expires_at<=?", now),
      this.p("DELETE FROM challenges WHERE expires_at<=?", now),
      this.p("DELETE FROM rate_limits WHERE window_end<=?", now),
    ]);
  }
  async decodeState(row, day) {
    if (!row) return null;
    let serialized = row.state_json;
    if (serialized === CHUNKED_SNAPSHOT_MARKER) {
      const chunks = await this.all(
        "SELECT chunk_index AS chunkIndex, chunk_data AS chunkData " +
        "FROM snapshot_chunks WHERE day=? ORDER BY chunk_index", day
      );
      if (chunks.length === 0) throw new Error("published snapshot chunks missing");
      serialized = chunks.map((chunk, index) => {
        if (Number(chunk.chunkIndex) !== index || typeof chunk.chunkData !== "string") {
          throw new Error("published snapshot chunk order is invalid");
        }
        return chunk.chunkData;
      }).join("");
    }
    // Reconstitute canonical JSON before checking the public-state digest.
    serialized = decodeSnapshotStorage(serialized);
    const hash = await hashText(serialized);
    if (hash !== row.sha256) throw new Error("published snapshot checksum mismatch");
    const state = JSON.parse(serialized);
    if (!state || !Array.isArray(state.cells) || !state.bounds || state.date !== day) {
      throw new Error("published snapshot format mismatch");
    }
    Object.defineProperty(state, VERIFIED_SNAPSHOT_SHA, {
      value: row.sha256, enumerable: false,
    });
    return state;
  }
  async latestDay() {
    const row = await this.first("SELECT day FROM snapshots ORDER BY day DESC LIMIT 1");
    return row?.day ?? null;
  }
  async latestState() {
    const row = await this.first(
      "SELECT day,state_json,sha256 FROM snapshots ORDER BY day DESC LIMIT 1"
    );
    return row ? this.decodeState(row, row.day) : null;
  }
  async publishedBounds() {
    const row = await this.first(
      "SELECT value FROM site_settings WHERE key='published_bounds'"
    );
    if (row) {
      const bounds = JSON.parse(row.value);
      if (!bounds || !["minX", "maxX", "minY", "maxY"]
        .every(k => Number.isSafeInteger(bounds[k])) ||
        bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
        throw new Error("published bounds configuration invalid");
      }
      return bounds;
    }
    // Compatibility with existing databases not yet containing cached
    // bounds. The first request may read the latest map, subsequent requests
    // only read the small metadata row.
    const state = await this.latestState();
    if (!state) return null;
    await this.run(
      "INSERT OR IGNORE INTO site_settings(key,value) VALUES('published_bounds',?)",
      JSON.stringify(state.bounds)
    );
    return state.bounds;
  }
  async snapshot(day) {
    assertIsoDay(day);
    const row = await this.first(
      "SELECT state_json,sha256 FROM snapshots WHERE day=?", day
    );
    return row ? { state: await this.decodeState(row, day), sha256: row.sha256 } : null;
  }
  async days(limit = 90) {
    safeInt(limit, "limit", 1);
    if (limit > 3650) throw new RangeError("limit too large");
    return this.all(
      "SELECT day,sha256 FROM snapshots ORDER BY day DESC LIMIT ?", limit
    );
  }
  async initialize(instant = this.clock()) {
    const existing = await this.latestState();
    if (existing) return existing;
    // Recover legacy databases that accepted posts before any snapshot was
    // initialized, including anonymized posts from deleted accounts.
    const pending = await this.first(
      "SELECT MIN(day) AS day FROM (" +
      "SELECT day FROM posts UNION ALL " +
      "SELECT day FROM orphaned_posts UNION ALL " +
      "SELECT day FROM closed_posts UNION ALL " +
      "SELECT day FROM day_closures)"
    );
    const today = dayAtInstant(instant);
    const firstDay = pending?.day && pending.day < today ? pending.day : today;
    const day = previousDay(firstDay);
    const state = {
      date: day, bounds: boundsForUserCount(await this.usersCount()), cells: [],
    };
    const text = JSON.stringify(state);
    await this.run(
      "INSERT OR IGNORE INTO snapshots(day,state_json,sha256,created_at) " +
      "SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM snapshots)",
      day, text, await hashText(text), this.now()
    );
    return await this.latestState();
  }
  async defaultRules() {
    const row = await this.first(
      "SELECT value FROM site_settings WHERE key='receiver_default'"
    );
    return row ? JSON.parse(row.value) : this.rulesDefault;
  }
  async dayRules(day) {
    assertIsoDay(day);
    const row = await this.first(
      "SELECT post_strength AS postStrength, same_glyph_mode AS sameGlyphMode, " +
      "min_outbound AS minimumOutgoingInfluence,rule_override AS ruleOverride " +
      "FROM day_config WHERE day=?", day
    );
    const defaults = await this.defaultRules();
    return {
      postStrength: row ? Number(row.postStrength) : 1,
      sameGlyphMode: row?.ruleOverride === 1 ? row.sameGlyphMode : defaults.sameGlyphMode,
      minimumOutgoingInfluence: row?.ruleOverride === 1
        ? Number(row.minimumOutgoingInfluence) : defaults.minimumOutgoingInfluence,
    };
  }
  /**
   * A sealed day has immutable submission membership. The D1 migration
   * additionally enforces this with SQL triggers, closing the read/write race.
   */
  async sealedDay(day) {
    assertIsoDay(day);
    return this.first(
      "SELECT day,rules_json AS rulesJson,user_count AS userCount," +
      "previous_hash AS previousHash," +
      "captured_post_count AS capturedPostCount " +
      "FROM day_closures WHERE day=?", day
    );
  }
  async submit(userId, day, x, y, char) {
    safeUser(userId);
    assertIsoDay(day);
    safeInt(x, "x");
    safeInt(y, "y");
    const glyph = normalizeGlyph(char);
    const base = boundsForUserCount(await this.usersCount());
    const bounds = (await this.publishedBounds()) ?? base;
    const minX = Math.min(bounds.minX, base.minX);
    const minY = Math.min(bounds.minY, base.minY);
    const maxX = Math.max(bounds.maxX, base.maxX);
    const maxY = Math.max(bounds.maxY, base.maxY);
    if (x < minX || x > maxX || y < minY || y > maxY) {
      throw new RangeError("post lies outside the active map");
    }
    if (await this.sealedDay(day) ||
        await this.first("SELECT 1 AS present FROM snapshots WHERE day=?", day)) {
      throw new Error("day already published or sealed");
    }
    try {
      const row = await this.first(
        "INSERT INTO posts(user_id,day,revision,x,y,char,updated_at) VALUES(?,?,1,?,?,?,?) " +
        "ON CONFLICT(user_id,day) DO UPDATE SET revision=posts.revision+1, " +
        "x=excluded.x, y=excluded.y, char=excluded.char, updated_at=excluded.updated_at " +
        "RETURNING revision",
        userId, day, x, y, glyph, this.now()
      );
      return { revision: Number(row.revision), day, x, y, char: glyph };
    } catch (error) {
      // A concurrent publisher can seal the day after the initial check.
      if (await this.sealedDay(day)) throw new Error("day already sealed");
      throw error;
    }
  }
  async currentPost(userId, day) {
    safeUser(userId);
    assertIsoDay(day);
    return await this.first(
      "SELECT day,revision,x,y,char FROM posts WHERE user_id=? AND day=?",
      userId, day
    ) ?? null;
  }
  async dailyPosts(day) {
    assertIsoDay(day);
    return this.all(
      "SELECT user_id AS userId,day AS date,revision,x,y,char FROM posts WHERE day=? ORDER BY user_id",
      day
    );
  }
  /**
   * Anonymous immutable submissions copied by the closure INSERT trigger.
   * Never read live posts after the day is sealed: an account can be deleted
   * before publication and its post row cascades away.
   */
  async sealedPosts(day) {
    assertIsoDay(day);
    const rows = await this.all(
      "SELECT post_order AS postOrder,revision,x,y,char " +
      "FROM closed_posts WHERE day=? ORDER BY post_order", day
    );
    return rows.map((row) => ({
      userId: "sealed-" + row.postOrder, date: day,
      revision: Number(row.revision), x: Number(row.x),
      y: Number(row.y), char: row.char,
    }));
  }
  async publishDay(day, instant = this.clock()) {
    assertIsoDay(day);
    const today = dayAtInstant(instant);
    if (day >= today) throw new RangeError("cannot publish an open day");
    const existing = await this.snapshot(day);
    if (existing) return { state: existing.state, existed: true };
    const previous = await this.latestState();
    if (!previous) throw new Error("database must be initialized");
    if (nextIsoDay(previous.date) !== day) {
      throw new RangeError("daily snapshots must be published in sequence");
    }
    // Never finalize a day unless the required anonymous capture trigger
    // actually exists. Without it, cleanup could permanently erase a
    // submitted glyph without adding it to the published snapshot.
    const captureTrigger = await this.first(
      "SELECT 1 AS present FROM sqlite_schema " +
      "WHERE type='trigger' AND name='capture_closed_day_posts'"
    );
    if (!captureTrigger) {
      throw new Error("day closure capture integrity guard is missing");
    }
    // A single INSERT seals the day before reading final submissions.
    // BEFORE INSERT/UPDATE triggers on posts reject all later writes.
    // If the calculation subsequently fails, the day intentionally remains
    // sealed so an operator can recover without losing the cutoff.
    const effective = await this.dayRules(day);
    const userCount = await this.usersCount();
    const previousHash = previous[VERIFIED_SNAPSHOT_SHA] ??
      (await this.snapshot(previous.date))?.sha256;
    if (!previousHash) throw new Error("previous snapshot is unavailable");
    await this.run(
      "INSERT OR IGNORE INTO day_closures(day,rules_json,user_count,previous_hash,closed_at) " +
      "VALUES(?,?,?,?,?)",
      day, JSON.stringify(effective), userCount, previousHash, this.now()
    );
    const closure = await this.sealedDay(day);
    if (!closure) throw new Error("day closure failed");
    if (closure.previousHash !== previousHash) {
      throw new Error("day closure refers to a different prior snapshot");
    }
    const config = JSON.parse(closure.rulesJson);
    const frozen = await this.sealedPosts(day);
    // The closure trigger records its exact copied count at the same atomic
    // INSERT that sealed the day. It remains available even after the author
    // deletes their account and original posts cascade away.
    const captured = closure.capturedPostCount;
    if (!Number.isSafeInteger(captured) || captured < 0 ||
        frozen.length !== captured) {
      throw new Error("day closure frozen post count integrity mismatch");
    }
    // A corrupt or partial closure must not silently publish an empty map
    // and delete still-accepted posts. Frozen copies survive later account
    // deletion, so their count may be HIGHER than the surviving linked rows.
    const incoming = await this.first(
      "SELECT " +
      "(SELECT COUNT(*) FROM posts WHERE day=?) AS livePosts," +
      "(SELECT COUNT(*) FROM orphaned_posts WHERE day=?) AS anonymousPosts",
      day, day
    );
    if (frozen.length < Number(incoming.livePosts) + Number(incoming.anonymousPosts)) {
      throw new Error("day closure capture integrity mismatch");
    }
    // Accepted posts may sit on an expanded grid that was unlocked by
    // users who subsequently deleted their accounts before this day was
    // sealed. The current user count can therefore be smaller than the
    // boundary at acceptance time. Infer the MINIMUM symmetric grid covering
    // every already-accepted coordinate; never reject such a final post.
    // The actual user count remains frozen in day_closures.user_count.
    let requiredGridSize = Number(closure.userCount);
    for (const post of frozen) {
      const sizeForX = post.x < 0 ? -2 * post.x : 2 * post.x + 1;
      const sizeForY = post.y < 0 ? -2 * post.y : 2 * post.y + 1;
      requiredGridSize = Math.max(requiredGridSize, sizeForX, sizeForY);
    }
    if (!Number.isSafeInteger(requiredGridSize)) {
      throw new RangeError("accepted post requires an invalid grid size");
    }
    const next = buildDailySnapshot(previous, frozen, {
      date: day, ...config, registeredUserCount: requiredGridSize,
    });
    const serialized = JSON.stringify(next);
    const digest = await hashText(serialized);
    // RLE covers large contiguous glyph regions without changing API JSON.
    // Existing raw JSON/chunks remain readable for previous releases.
    const storage = encodeSnapshotStorage(next, serialized);
    const chunks = snapshotParts(storage);
    const stateValue = chunks.length > 0 ? CHUNKED_SNAPSHOT_MARKER : storage;
    // Each INSERT can carry two chunks via a SELECT/UNION. This reduces
    // per-invocation D1 query count while preserving per-value row limits.
    const chunkWrites = [];
    for (let index = 0; index < chunks.length; index += 2) {
      const group = chunks.slice(index, index + 2);
      const query = group.map(() =>
        "SELECT ?,?,? FROM snapshots WHERE day=? AND sha256=? AND state_json=?"
      ).join(" UNION ALL ");
      const params = group.flatMap((chunk, offset) =>
        [day, index + offset, chunk, day, digest, CHUNKED_SNAPSHOT_MARKER]
      );
      chunkWrites.push(this.p(
        "INSERT OR IGNORE INTO snapshot_chunks(day,chunk_index,chunk_data) " + query,
        ...params
      ));
    }
    // D1 batch is a transaction. The immutable unique day key prevents
    // competing publishers from overwriting one another.
    const writes = await this.db.batch([
      this.p(
        "INSERT INTO day_config(day,post_strength,same_glyph_mode,min_outbound,rule_override) VALUES(?,?,?,?,1) " +
        "ON CONFLICT(day) DO UPDATE SET post_strength=excluded.post_strength," +
        "same_glyph_mode=excluded.same_glyph_mode,min_outbound=excluded.min_outbound,rule_override=1 " +
        "WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE day=?)",
        day, config.postStrength, config.sameGlyphMode, config.minimumOutgoingInfluence, day
      ),
      this.p(
        "INSERT OR IGNORE INTO snapshots(day,state_json,sha256,created_at) VALUES(?,?,?,?)",
        day, stateValue, digest, this.now()
      ),
      ...chunkWrites,
      // Make the public grid bounds readable without fetching every map cell
      // on each authenticated post. The guard prevents a competing publisher
      // with a different digest from storing incorrect metadata.
      this.p(
        "INSERT INTO site_settings(key,value) " +
        "SELECT 'published_bounds',? WHERE EXISTS (" +
        "SELECT 1 FROM snapshots WHERE day=? AND sha256=?) " +
        "AND NOT EXISTS (SELECT 1 FROM snapshots WHERE day>?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(next.bounds), day, digest, day
      ),
      // Snapshot, chunks, and removal of source identifying posts are one
      // atomic transaction: never erase information needed for a retry.
      this.p("DELETE FROM closed_posts WHERE day=?", day),
      this.p("DELETE FROM orphaned_posts WHERE day=?", day),
      this.p("DELETE FROM posts WHERE day=?", day),
    ]);
    // A successful INSERT and its chunks were committed in one D1 batch.
    // Returning the in-memory state avoids a second full JSON decode of a
    // 200k+ cell map. Only a lost concurrent insert needs to re-read storage.
    if (writes[1]?.meta?.changes === 1) {
      return { state: next, existed: false };
    }
    const stored = await this.snapshot(day);
    if (!stored) throw new Error("snapshot write was not committed");
    return { state: stored.state, existed: true };
  }
  async publishClosedDays(instant = this.clock(), maxDays = 32) {
    safeInt(maxDays, "maxDays", 1);
    if (maxDays > 366) throw new RangeError("maxDays cannot exceed 366");
    const today = dayAtInstant(instant);
    let current = await this.latestState();
    if (!current) current = await this.initialize(instant);
    const output = [];
    for (let i = 0; i < maxDays; i++) {
      const next = nextIsoDay(current.date);
      if (next >= today) break;
      const result = await this.publishDay(next, instant);
      current = result.state;
      output.push({ date: next, cells: current.cells.length, existed: result.existed });
    }
    return output;
  }
}
