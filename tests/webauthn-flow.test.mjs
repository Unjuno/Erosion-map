import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { Store } from "../server/store.mjs";
import { createApplication } from "../server/http.mjs";

const ORIGIN = "http://localhost:4173";
const hash = (data) => createHash("sha256").update(data).digest();
const b64url = (data) => Buffer.from(data).toString("base64url");

function cborHeader(major, length) {
  if (!Number.isInteger(length) || length < 0) throw new RangeError("invalid CBOR length");
  if (length <= 23) return Buffer.from([major * 32 + length]);
  if (length < 256) return Buffer.from([major * 32 + 24, length]);
  if (length < 65536) return Buffer.from([major * 32 + 25, length >> 8, length & 255]);
  throw new RangeError("oversized test CBOR input");
}
function cborText(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([cborHeader(3, bytes.length), bytes]);
}
function cborBytes(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([cborHeader(2, bytes.length), bytes]);
}
function cborMap(pairs) {
  const parts = [cborHeader(5, pairs.length)];
  for (const [key, value] of pairs) {
    parts.push(cborText(key), value);
  }
  return Buffer.concat(parts);
}
function uint32(number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(number);
  return buffer;
}
function simulatedAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  assert.equal(x.length, 32);
  assert.equal(y.length, 32);
  const idBytes = randomBytes(16);
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x, Buffer.from([0x22, 0x58, 0x20]), y,
  ]);
  const id = b64url(idBytes);
  return {
    id,
    register(challenge, origin = ORIGIN) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.create", challenge, origin, crossOrigin: false,
      }));
      const rpHash = hash("localhost");
      const authData = Buffer.concat([
        rpHash, Buffer.from([0x45]), uint32(0), Buffer.alloc(16),
        Buffer.from([0, idBytes.length]), idBytes, cose,
      ]);
      const attestationObject = cborMap([
        ["fmt", cborText("none")],
        ["attStmt", cborMap([])],
        ["authData", cborBytes(authData)],
      ]);
      return {
        id, rawId: id, type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    authenticate(challenge, userHandle, origin = ORIGIN, counter = 1) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.get", challenge, origin, crossOrigin: false,
      }));
      const authenticatorData = Buffer.concat([
        hash("localhost"), Buffer.from([0x05]), uint32(counter),
      ]);
      const signedBytes = Buffer.concat([
        authenticatorData, hash(clientDataJSON),
      ]);
      return {
        id, rawId: id, type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(sign("sha256", signedBytes, privateKey)),
          userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}
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
    assert.notEqual(response.res.status, 200);
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
    assert.notEqual(invalid.res.status, 200);
    assert.equal((await get("/api/me")).json.authenticated, false);
  });
});
