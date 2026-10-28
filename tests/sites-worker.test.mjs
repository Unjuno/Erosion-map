import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, stat } from "node:fs/promises";
import { handleRequest } from "../sites/worker.mjs";
import { hashText } from "../sites/d1-store.mjs";

const origin = "https://erosion.example.org";
const clock = () => new Date("2026-10-20T14:00:00.000Z");
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const wrap = (sql, args = []) => ({
    bind(...params) { return wrap(sql, params); },
    async first() { return sqlite.prepare(sql).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() {
      const result = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  const DB = {
    prepare: (sql) => wrap(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const staticHits = [];
  const ASSETS = {
    async fetch(request) {
      staticHits.push(new URL(request.url).pathname);
      return new Response("<h1>EROSION MAP</h1>", {
        headers: { "content-type": "text/html" },
      });
    },
  };
  const env = {
    DB, ASSETS, PUBLIC_ORIGIN: origin, RP_ID: "example.org",
    SAME_GLYPH_MODE: "max", N1_OUTBOUND: "1",
  };
  const context = { now: clock };
  const fetcher = (path, options) => handleRequest(
    new Request(origin + path, options), env, context
  );
  const post = (path, payload, options = {}) => fetcher(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(payload),
  });
  return {
    sqlite, env, context, fetcher, post, staticHits,
    async setup() {
      sqlite.exec(await readFile("migrations/0001_d1_schema.sql", "utf8"));
    },
    close() { sqlite.close(); },
  };
}

test("Sites-compatible worker can be bundled as a static deployment artifact", async () => {
  const bundle = await stat("site/_worker.js");
  assert.ok(bundle.size > 30_000, "Sites worker has bundled WebAuthn module");
  const source = await readFile("site/_worker.js", "utf8");
  assert.match(source, /async function handleRequest/);
  assert.doesNotMatch(source, /internal Work handoff/);
});

test("Sites worker protects D1 and serves only public map data", async () => {
  const f = fixture();
  try {
    await f.setup();
    const status = await f.fetcher("/api/status");
    assert.equal(status.status, 200);
    assert.equal((await status.json()).mode, "sites-d1");
    const world = await f.fetcher("/api/state");
    assert.equal(world.status, 200);
    const state = await world.json();
    assert.equal(state.state.date, "2026-10-19");
    assert.equal(state.sha256, await hashText(JSON.stringify(state.state)));
    const days = await (await f.fetcher("/api/history")).json();
    assert.equal(days.days.length, 1);
    const unknown = await f.fetcher("/api/state?date=2025-01-01");
    assert.equal(unknown.status, 404);
    assert.equal((await f.fetcher("/api/me")).status, 200);
    const unauthorized = await f.post("/api/post", { char: "森", x: 0, y: 0 });
    assert.equal(unauthorized.status, 401);
  } finally { f.close(); }
});

test("Sites worker never trusts host, invalid origin or cross-origin requests", async () => {
  const f = fixture();
  try {
    await f.setup();
    assert.equal((await f.post("/api/auth/login/start", {},
      { headers: { Origin: "https://evil.example" } })).status, 403);
    const request = new Request(origin + "/api/post", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ char: "星", x: 0, y: 0 }),
    });
    assert.equal((await handleRequest(request, f.env, f.context)).status, 403);
    const malformed = await f.fetcher("/api/post", { method: "POST" });
    assert.equal(malformed.status, 403);
    assert.equal((await handleRequest(new Request(origin + "/api/status"),
      { ...f.env, PUBLIC_ORIGIN: "http://not-secure.example" })).status, 503);
  } finally { f.close(); }
});

test("Sites worker issues per-registration challenge without email", async () => {
  const f = fixture();
  try {
    await f.setup();
    const started = await f.post("/api/auth/register/start", {});
    assert.equal(started.status, 200);
    const options = (await started.json()).options;
    assert.equal(options.rp.id, "example.org");
    assert.equal(options.authenticatorSelection.userVerification, "required");
    assert.match(started.headers.get("set-cookie"), /__Host-erosion-challenge=/);
    const cookie = started.headers.get("set-cookie").split(";")[0];
    const malformed = await f.post("/api/auth/register/finish", {
      credential: { id: "forged" },
    }, { headers: { Cookie: cookie } });
    assert.equal(malformed.status, 400);
    const again = await f.post("/api/auth/register/finish", {
      credential: { id: "forged" },
    }, { headers: { Cookie: cookie } });
    assert.equal(again.status, 400);
    const login = await f.post("/api/auth/login/start", {});
    assert.equal(login.status, 200);
    assert.equal((await login.json()).options.rpId, "example.org");
  } finally { f.close(); }
});

test("Sites worker serves map, post, ranking and policy through asset binding", async () => {
  const f = fixture();
  try {
    await f.setup();
    for (const [path, asset] of [
      ["/", "/index.html"], ["/submit", "/account.html"],
      ["/ranking", "/ranking.html"], ["/policy", "/policy.html"],
    ]) {
      const response = await f.fetcher(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
      assert.equal(f.staticHits.at(-1), asset);
    }
  } finally { f.close(); }
});
