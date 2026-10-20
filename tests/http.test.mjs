import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Store } from "../server/store.mjs";
import { createApplication } from "../server/http.mjs";

const ORIGIN = "http://localhost:4173";
async function withServer(callback) {
  const store = new Store();
  store.initialize(new Date("2026-10-20T12:00:00Z"));
  const server = createApplication({
    store, origin: ORIGIN, rpID: "localhost",
    clock: () => new Date("2026-10-20T12:00:00Z"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  try { await callback({ store, base }); }
  finally { await new Promise((resolve) => server.close(resolve)); store.close(); }
}
const post = (base, path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

test("HTTP offers published map and history with no PII", async () => {
  await withServer(async ({ base }) => {
    const response = await fetch(base + "/api/state");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state.date, "2026-10-19");
    const history = await (await fetch(base + "/api/history")).json();
    assert.deepEqual(history.days.map((v) => v.day), ["2026-10-19"]);
    const unauth = await (await fetch(base + "/api/me")).json();
    assert.deepEqual(unauth, { authenticated: false, day: "2026-10-20" });
  });
});

test("CSRF origin check rejects mismatched and missing Origin", async () => {
  await withServer(async ({ base }) => {
    const wrong = await post(base, "/api/auth/login/start", {},
      { Origin: "https://malicious.example" });
    assert.equal(wrong.status, 403);
    const missing = await fetch(base + "/api/post", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: 0, y: 0, char: "A" }),
    });
    assert.equal(missing.status, 403);
  });
});

test("passkey options are generated and the challenge is one-use", async () => {
  await withServer(async ({ base }) => {
    const begin = await post(base, "/api/auth/register/start", {});
    assert.equal(begin.status, 200);
    const options = (await begin.json()).options;
    assert.equal(options.rp.id, "localhost");
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const cookie = begin.headers.get("set-cookie").split(";")[0];
    const failed = await post(base, "/api/auth/register/finish", {
      credential: { id: "invalid", type: "public-key" },
    }, { Cookie: cookie });
    assert.ok(failed.status >= 400);
    const replayed = await post(base, "/api/auth/register/finish", {
      credential: { id: "invalid" },
    }, { Cookie: cookie });
    assert.equal(replayed.status, 400);
  });
});

test("anonymous users cannot submit posts", async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, "/api/post", { x: 0, y: 0, char: "A" });
    assert.equal(response.status, 401);
  });
});

test("login challenge is discoverable-credential based, no email required", async () => {
  await withServer(async ({ base }) => {
    const response = await post(base, "/api/auth/login/start", {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.options.rpId, "localhost");
    assert.deepEqual(result.options.allowCredentials, []);
  });
});


test("all four documented site routes serve the correct HTML", async () => {
  await withServer(async ({ base }) => {
    for (const [path, marker] of [
      ["/", "mapCanvas"],
      ["/submit", "realPostForm"],
      ["/ranking", "rankingRows"],
      ["/policy", "正式なプライバシーポリシーや利用規約としては未発効"],
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.ok((await response.text()).includes(marker), path);
    }
  });
});
