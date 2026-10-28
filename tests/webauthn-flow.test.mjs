import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { Store } from "../server/store.mjs";
import { createApplication } from "../server/http.mjs";

import { b64url, simulatedAuthenticator } from "./helpers/authenticator.mjs";
const ORIGIN = "http://localhost:4173";
async function withServer(run) {
  const store = new Store();
  store.initialize(new Date("2026-10-20T12:00:00Z"));
  const server = createApplication({
    store, origin: ORIGIN, rpID: "localhost",
    clock: () => new Date("2026-10-20T12:00:00Z"),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = "http://127.0.0.1:" + server.address().port;
  const post = async (url, body, cookies = "") => {
    const res = await fetch(root + url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  };
  const get = async (url, cookie = "") => {
    const res = await fetch(root + url, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    return { res, json: await res.json() };
  };
  try {
    await run({ store, post, get });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}
function cookie(setCookieHeader, name) {
  const pattern = new RegExp("(?:^|,\\s*)" + name + "=([^;]+)");
  const match = pattern.exec(setCookieHeader);
  assert.ok(match, "expected Set-Cookie " + name + ": " + setCookieHeader);
  return name + "=" + match[1];
}

test("cryptographic passkey registration, login and authenticated post end-to-end", async () => {
  await withServer(async ({ store, post, get }) => {
    const authenticator = simulatedAuthenticator();
    const begin = await post("/api/auth/register/start", {});
    assert.equal(begin.res.status, 200);
    const pendingCookie = cookie(begin.res.headers.get("set-cookie"), "erosion_challenge");

    const finish = await post("/api/auth/register/finish", {
      credential: authenticator.register(begin.json.options.challenge),
    }, pendingCookie);
    assert.equal(finish.res.status, 200, JSON.stringify(finish.json));
    assert.equal(finish.json.authenticated, true);
    assert.equal(store.usersCount(), 1);
    const activeCookie = cookie(finish.res.headers.get("set-cookie"), "erosion_session");

    const me = await get("/api/me", activeCookie);
    assert.equal(me.res.status, 200);
    assert.equal(me.json.authenticated, true);
    assert.equal(me.json.credentialCount, 1);

    const first = await post("/api/post", { x: 5, y: 7, char: "森" }, activeCookie);
    assert.equal(first.res.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.saved.revision, 1);
    const second = await post("/api/post", { x: 6, y: 7, char: "海" }, activeCookie);
    assert.equal(second.res.status, 200);
    assert.equal(second.json.saved.revision, 2);
    assert.equal((await get("/api/me", activeCookie)).json.post.char, "海");

    const signedOut = await post("/api/auth/logout", {}, activeCookie);
    assert.equal(signedOut.res.status, 200);
    assert.equal((await get("/api/me", activeCookie)).json.authenticated, false);
    assert.equal((await post("/api/post", { x: 0, y: 0, char: "星" }, activeCookie)).res.status, 401);

    const wrongLogin = await post("/api/auth/login/start", {});
    assert.equal(wrongLogin.res.status, 200);
    const wrongCookie = cookie(wrongLogin.res.headers.get("set-cookie"), "erosion_challenge");
    const wrongHandleAssertion = authenticator.authenticate(
      wrongLogin.json.options.challenge,
      b64url(Buffer.from("different-account-id", "utf8")),
    );
    const rejected = await post("/api/auth/login/finish", {
      credential: wrongHandleAssertion,
    }, wrongCookie);
    assert.equal(rejected.res.status, 400);
    assert.equal(rejected.json.error, "passkey user handle mismatch");

    const startLogin = await post("/api/auth/login/start", {});
    assert.equal(startLogin.res.status, 200);
    const loginCookie = cookie(startLogin.res.headers.get("set-cookie"), "erosion_challenge");
    const verified = await post("/api/auth/login/finish", {
      credential: authenticator.authenticate(
        startLogin.json.options.challenge, begin.json.options.user.id,
      ),
    }, loginCookie);
    assert.equal(verified.res.status, 200, JSON.stringify(verified.json));
    const reauthenticated = cookie(verified.res.headers.get("set-cookie"), "erosion_session");
    assert.equal((await get("/api/me", reauthenticated)).json.authenticated, true);
    assert.equal(store.credentialById(authenticator.id).counter, 1);

    const replay = await post("/api/auth/login/finish", {
      credential: authenticator.authenticate(
        startLogin.json.options.challenge, begin.json.options.user.id,
      ),
    }, loginCookie);
    assert.equal(replay.res.status, 400);
  });
});

test("invalid WebAuthn RP origin never provisions a user", async () => {
  await withServer(async ({ store, post }) => {
    const authenticator = simulatedAuthenticator();
    const begin = await post("/api/auth/register/start", {});
    const pendingCookie = cookie(begin.res.headers.get("set-cookie"), "erosion_challenge");
    const response = await post("/api/auth/register/finish", {
      credential: authenticator.register(
        begin.json.options.challenge, "https://unrelated.example",
      ),
    }, pendingCookie);
    assert.equal(response.res.status, 400);
    assert.equal(response.json.error, "passkey verification failed");
    assert.equal(store.usersCount(), 0);
  });
});

test("tampered passkey assertion does not authenticate", async () => {
  await withServer(async ({ post, get }) => {
    const authenticator = simulatedAuthenticator();
    const begin = await post("/api/auth/register/start", {});
    const pending = cookie(begin.res.headers.get("set-cookie"), "erosion_challenge");
    const finish = await post("/api/auth/register/finish", {
      credential: authenticator.register(begin.json.options.challenge),
    }, pending);
    assert.equal(finish.res.status, 200);

    const start = await post("/api/auth/login/start", {});
    const loginCookie = cookie(start.res.headers.get("set-cookie"), "erosion_challenge");
    const assertion = authenticator.authenticate(
      start.json.options.challenge, begin.json.options.user.id,
    );
    assertion.response.signature = b64url(randomBytes(70));
    const invalid = await post("/api/auth/login/finish", {
      credential: assertion,
    }, loginCookie);
    assert.equal(invalid.res.status, 400);
    assert.equal(invalid.json.error, "passkey verification failed");
    assert.equal((await get("/api/me")).json.authenticated, false);
  });
});


test("existing account can add a second passkey, without creating a new user", async () => {
  await withServer(async ({ store, post, get }) => {
    const original = simulatedAuthenticator();
    const start = await post("/api/auth/register/start", {});
    const registration = await post("/api/auth/register/finish", {
      credential: original.register(start.json.options.challenge),
    }, cookie(start.res.headers.get("set-cookie"), "erosion_challenge"));
    assert.equal(registration.res.status, 200);
    const session = cookie(registration.res.headers.get("set-cookie"), "erosion_session");

    const additional = simulatedAuthenticator();
    const newStart = await post("/api/auth/register/start", {}, session);
    assert.equal(newStart.res.status, 200);
    assert.deepEqual(
      newStart.json.options.excludeCredentials.map((record) => record.id),
      [original.id],
    );
    const newChallenge = cookie(newStart.res.headers.get("set-cookie"), "erosion_challenge");
    const finished = await post("/api/auth/register/finish", {
      credential: additional.register(newStart.json.options.challenge),
    }, session + "; " + newChallenge);
    assert.equal(finished.res.status, 200, JSON.stringify(finished.json));
    assert.equal(store.usersCount(), 1);
    const updatedSession = cookie(finished.res.headers.get("set-cookie"), "erosion_session");
    assert.equal((await get("/api/me", updatedSession)).json.credentialCount, 2);
    assert.equal((await get("/api/me", session)).json.authenticated, false);
  });
});


test("account deletion requires another signed passkey and removes only private data", async () => {
  await withServer(async ({ store, post, get }) => {
    const authenticator = simulatedAuthenticator();
    const begin = await post("/api/auth/register/start", {});
    const registered = await post("/api/auth/register/finish", {
      credential: authenticator.register(begin.json.options.challenge),
    }, cookie(begin.res.headers.get("set-cookie"), "erosion_challenge"));
    assert.equal(registered.res.status, 200);
    const session = cookie(registered.res.headers.get("set-cookie"), "erosion_session");
    assert.equal((await post("/api/post", { x: 1, y: 2, char: "森" }, session)).res.status, 200);
    const started = await post("/api/account/delete/start", {}, session);
    assert.equal(started.res.status, 200);
    const pending = cookie(started.res.headers.get("set-cookie"), "erosion_challenge");
    const assertion = authenticator.authenticate(
      started.json.options.challenge, begin.json.options.user.id,
    );
    const noConfirmation = await post("/api/account/delete/finish", {
      confirm: "NO", credential: assertion,
    }, session + "; " + pending);
    assert.equal(noConfirmation.res.status, 400);
    assert.equal(store.usersCount(), 1);

    const tampered = await post("/api/account/delete/finish", {
      confirm: "DELETE", credential: {
        ...assertion, response: {
          ...assertion.response, signature: b64url(randomBytes(70)),
        },
      },
    }, session + "; " + pending);
    assert.equal(tampered.res.status, 400);
    assert.equal(store.usersCount(), 1);

    const retry = await post("/api/account/delete/start", {}, session);
    const deletion = await post("/api/account/delete/finish", {
      confirm: "DELETE",
      credential: authenticator.authenticate(
        retry.json.options.challenge, begin.json.options.user.id,
      ),
    }, session + "; " +
      cookie(retry.res.headers.get("set-cookie"), "erosion_challenge"));
    assert.equal(deletion.res.status, 200, JSON.stringify(deletion.json));
    assert.deepEqual(deletion.json, { deleted: true });
    assert.equal(store.usersCount(), 0);
    assert.equal(store.credentialById(authenticator.id), null);
    assert.equal(store.dailyPosts("2026-10-20").length, 0);
    assert.equal((await get("/api/me", session)).json.authenticated, false);
    assert.ok(store.snapshot("2026-10-19")?.state);
  });
});

test("user-bound deletion challenges cannot be replayed at login", async () => {
  await withServer(async ({ post }) => {
    const authenticator = simulatedAuthenticator();
    const begin = await post("/api/auth/register/start", {});
    const registered = await post("/api/auth/register/finish", {
      credential: authenticator.register(begin.json.options.challenge),
    }, cookie(begin.res.headers.get("set-cookie"), "erosion_challenge"));
    assert.equal(registered.res.status, 200);
    const session = cookie(registered.res.headers.get("set-cookie"), "erosion_session");
    const challenge = await post("/api/account/delete/start", {}, session);
    const pending = cookie(challenge.res.headers.get("set-cookie"), "erosion_challenge");
    const reused = await post("/api/auth/login/finish", {
      credential: authenticator.authenticate(
        challenge.json.options.challenge, begin.json.options.user.id,
      ),
    }, session + "; " + pending);
    assert.equal(reused.res.status, 400);
    assert.equal(reused.json.error, "challenge is bound to a different operation");
  });
});
