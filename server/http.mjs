/**
 * Local single-node WebAuthn server. Public deployment requires provider
 * configuration, persistent storage, external rate limiting and review.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { dayAtInstant } from "../dist/calendar.js";

const hash = (secret) => createHash("sha256").update(secret).digest("hex");
const randomToken = () => randomBytes(32).toString("base64url");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
class HTTPError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function parseCookies(value = "") {
  const entries = value.split(";").map((pair) => pair.trim());
  const result = new Map();
  for (const part of entries) {
    const index = part.indexOf("=");
    if (index >= 1) result.set(part.slice(0, index), part.slice(index + 1));
  }
  return result;
}
function setCookie(name, value, secure, maxAge) {
  return name + "=" + value +
    "; Path=/; HttpOnly; SameSite=Strict" +
    (secure ? "; Secure" : "") +
    "; Max-Age=" + maxAge;
}
function json(reply, status, body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  reply.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  reply.end(bytes);
}
async function readJSON(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HTTPError(413, "request body too large");
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HTTPError(400, "invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HTTPError(400, "expected JSON object");
  }
  return parsed;
}
async function verifyPasskeyInput(verify) {
  try {
    return await verify();
  } catch {
    // Cryptographic/format validation failures are client errors, not 500s.
    // Do not echo untrusted WebAuthn payloads or library internals.
    throw new HTTPError(400, "passkey verification failed");
  }
}
function errorMessage(error) {
  if (error instanceof HTTPError) return { status: error.status, message: error.message };
  if (error instanceof RangeError || error instanceof SyntaxError) {
    return { status: 400, message: error.message };
  }
  return { status: 500, message: "internal server error" };
}

/**
 * Configured origin and RP ID are authoritative; never infer either from
 * Host or X-Forwarded-* request headers.
 */
export function createApplication({
  store,
  origin = "http://localhost:4173",
  rpID = "localhost",
  sitePath = resolve(import.meta.dirname, "../site"),
  clock = () => new Date(),
}) {
  const expectedOrigin = new URL(origin).origin;
  if (!expectedOrigin.startsWith("https://") &&
      expectedOrigin !== "http://localhost:4173" &&
      !/^http:\/\/localhost:\d{1,5}$/.test(expectedOrigin)) {
    throw new RangeError("non-local production origins must use HTTPS");
  }
  if (new URL(expectedOrigin).hostname !== rpID &&
      !new URL(expectedOrigin).hostname.endsWith("." + rpID)) {
    throw new RangeError("RP ID must match the configured origin domain");
  }
  const secure = expectedOrigin.startsWith("https://");
  const directory = resolve(sitePath);
  const rate = new Map();
  const canAttempt = (req) => {
    const address = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const record = rate.get(address);
    if (!record || now - record.start >= 60_000) {
      rate.set(address, { start: now, requests: 1 });
      return true;
    }
    record.requests++;
    return record.requests <= 60;
  };
  const sessionUser = (req) => {
    const token = parseCookies(req.headers.cookie).get("erosion_session");
    return token ? store.userForSession(hash(token)) : null;
  };
  const requireUser = (req) => {
    const id = sessionUser(req);
    if (id === null) throw new HTTPError(401, "passkey login required");
    return id;
  };
  const pendingChallenge = (req, kind) => {
    const token = parseCookies(req.headers.cookie).get("erosion_challenge");
    if (typeof token !== "string") throw new HTTPError(400, "missing challenge");
    const record = store.consumeChallenge(hash(token), kind);
    if (!record) throw new HTTPError(400, "challenge expired or already used");
    return record;
  };
  const mintSession = (userId, priorToken = null) => {
    if (priorToken) store.revokeSession(hash(priorToken));
    const token = randomToken();
    store.issueSession(hash(token), userId);
    return setCookie("erosion_session", token, secure, 7 * 86400);
  };
  const clearPending = () => setCookie("erosion_challenge", "", secure, 0);
  const verifyAssertion = async (payload, pending, expectedUserId = null) => {
    const credential = store.credentialById(payload.credential?.id);
    if (!credential) throw new HTTPError(400, "unknown passkey");
    if (expectedUserId !== null && credential.userId !== expectedUserId) {
      throw new HTTPError(400, "passkey does not belong to this account");
    }
    const handle = payload.credential?.response?.userHandle;
    if (handle !== null && handle !== undefined &&
        (typeof handle !== "string" || !/^[A-Za-z0-9_-]+$/.test(handle) ||
        !Buffer.from(handle, "base64url")
          .equals(Buffer.from(credential.userId, "utf8")))) {
      throw new HTTPError(400, "passkey user handle mismatch");
    }
    const verified = await verifyPasskeyInput(() => verifyAuthenticationResponse({
      response: payload.credential, expectedChallenge: pending.challenge,
      expectedOrigin, expectedRPID: rpID,
      credential: {
        id: credential.id, publicKey: credential.publicKey,
        counter: credential.counter, transports: credential.transports,
      },
      requireUserVerification: true,
    }));
    if (!verified.verified || !verified.authenticationInfo) {
      throw new HTTPError(400, "authentication verification failed");
    }
    store.updateCounter(credential.id, credential.counter,
      verified.authenticationInfo.newCounter);
    return credential.userId;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", expectedOrigin);
      const path = url.pathname;
      const method = req.method || "GET";

      if (path.startsWith("/api/")) {
        // Cross-origin browser requests are not accepted.
        if (method !== "GET" && method !== "HEAD") {
          if (req.headers.origin !== expectedOrigin) {
            throw new HTTPError(403, "invalid request origin");
          }
          if (!canAttempt(req)) throw new HTTPError(429, "rate limit exceeded");
          const contentType = String(req.headers["content-type"] ?? "");
          if (!contentType.startsWith("application/json")) {
            throw new HTTPError(415, "application/json required");
          }
        }
        if (path === "/api/status" && method === "GET") {
          json(res, 200, {
            mode: "sqlite-local-preview",
            latestDay: store.latestState()?.date ?? null,
          });
          return;
        }
        if (path === "/api/state" && method === "GET") {
          const date = url.searchParams.get("date");
          const found = date ? store.snapshot(date) :
            (store.latestState() ? store.snapshot(store.latestState().date) : null);
          if (!found) throw new HTTPError(404, "snapshot not found");
          json(res, 200, { state: found.state, sha256: found.sha256 });
          return;
        }
        if (path === "/api/history" && method === "GET") {
          json(res, 200, { days: store.days(180) });
          return;
        }
        if (path === "/api/me" && method === "GET") {
          const id = sessionUser(req);
          const day = dayAtInstant(clock());
          json(res, 200, id === null
            ? { authenticated: false, day }
            : {
                authenticated: true, userId: id, day,
                credentialCount: store.credentialsByUser(id).length,
                post: store.currentPost(id, day),
              });
          return;
        }
        if (path === "/api/auth/register/start" && method === "POST") {
          await readJSON(req);
          const already = sessionUser(req);
          const userId = already ?? randomUUID();
          const options = await generateRegistrationOptions({
            rpName: "Erosion Map",
            rpID,
            userName: "erosion-" + userId.slice(0, 8),
            userID: Buffer.from(userId, "utf8"),
            attestationType: "none",
            authenticatorSelection: {
              residentKey: "required", userVerification: "required",
            },
            excludeCredentials: already === null ? [] :
              store.credentialsByUser(already).map((credential) => ({
                id: credential.id, transports: credential.transports,
              })),
          });
          const token = randomToken();
          store.issueChallenge(hash(token), "register", options.challenge, userId);
          json(res, 200, { options }, {
            "Set-Cookie": setCookie("erosion_challenge", token, secure, 300),
          });
          return;
        }
        if (path === "/api/auth/register/finish" && method === "POST") {
          const payload = await readJSON(req);
          const pending = pendingChallenge(req, "register");
          const already = store.hasUser(pending.userId);
          if (already && sessionUser(req) !== pending.userId) {
            throw new HTTPError(403, "current session required to add passkey");
          }
          const checked = await verifyPasskeyInput(() => verifyRegistrationResponse({
            response: payload.credential,
            expectedChallenge: pending.challenge,
            expectedOrigin,
            expectedRPID: rpID,
            requireUserVerification: true,
          }));
          if (!checked.verified || !checked.registrationInfo) {
            throw new HTTPError(400, "registration verification failed");
          }
          store.registerCredential(pending.userId,
            checked.registrationInfo.credential, !already);
          const old = parseCookies(req.headers.cookie).get("erosion_session");
          const cookie = mintSession(pending.userId, old);
          json(res, 200, { authenticated: true }, {
            "Set-Cookie": [clearPending(), cookie],
          });
          return;
        }
        if (path === "/api/auth/login/start" && method === "POST") {
          await readJSON(req);
          const options = await generateAuthenticationOptions({
            rpID, userVerification: "required", allowCredentials: [],
          });
          const token = randomToken();
          store.issueChallenge(hash(token), "authenticate", options.challenge);
          json(res, 200, { options }, {
            "Set-Cookie": setCookie("erosion_challenge", token, secure, 300),
          });
          return;
        }
        if (path === "/api/auth/login/finish" && method === "POST") {
          const payload = await readJSON(req);
          const pending = pendingChallenge(req, "authenticate");
          if (pending.userId !== null) {
            throw new HTTPError(400, "challenge is bound to a different operation");
          }
          const authenticatedUser = await verifyAssertion(payload, pending);
          const old = parseCookies(req.headers.cookie).get("erosion_session");
          const cookie = mintSession(authenticatedUser, old);
          json(res, 200, { authenticated: true }, {
            "Set-Cookie": [clearPending(), cookie],
          });
          return;
        }
        if (path === "/api/account/delete/start" && method === "POST") {
          const userId = requireUser(req);
          await readJSON(req);
          const options = await generateAuthenticationOptions({
            rpID, userVerification: "required",
            allowCredentials: store.credentialsByUser(userId).map((credential) => ({
              id: credential.id, transports: credential.transports,
            })),
          });
          const token = randomToken();
          store.issueChallenge(hash(token), "authenticate", options.challenge, userId);
          json(res, 200, { options }, {
            "Set-Cookie": setCookie("erosion_challenge", token, secure, 300),
          });
          return;
        }
        if (path === "/api/account/delete/finish" && method === "POST") {
          const userId = requireUser(req);
          const payload = await readJSON(req);
          if (payload.confirm !== "DELETE") {
            throw new HTTPError(400, "explicit deletion confirmation required");
          }
          const pending = pendingChallenge(req, "authenticate");
          if (pending.userId !== userId) {
            throw new HTTPError(400, "challenge is not bound to this account");
          }
          await verifyAssertion(payload, pending, userId);
          store.deleteUser(userId);
          json(res, 200, { deleted: true }, {
            "Set-Cookie": [
              clearPending(),
              setCookie("erosion_session", "", secure, 0),
            ],
          });
          return;
        }
        if (path === "/api/auth/logout" && method === "POST") {
          await readJSON(req);
          const token = parseCookies(req.headers.cookie).get("erosion_session");
          if (token) store.revokeSession(hash(token));
          json(res, 200, { authenticated: false }, {
            "Set-Cookie": setCookie("erosion_session", "", secure, 0),
          });
          return;
        }
        if (path === "/api/post" && method === "POST") {
          const userId = requireUser(req);
          const data = await readJSON(req);
          const day = dayAtInstant(clock());
          const saved = store.submit(userId, day, data.x, data.y, data.char);
          json(res, 200, { saved });
          return;
        }
        throw new HTTPError(404, "API route not found");
      }
      if (method !== "GET" && method !== "HEAD") {
        throw new HTTPError(405, "method not allowed");
      }
      const decodedPath = decodeURIComponent(path);
      const aliases = new Map([
        ["/submit", "account.html"],
        ["/ranking", "ranking.html"],
        ["/policy", "policy.html"],
      ]);
      const relative = aliases.get(decodedPath) ??
        (decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, ""));
      const filename = resolve(directory, relative);
      if (!filename.startsWith(directory + sep)) throw new HTTPError(403, "forbidden");
      let content;
      try { content = await readFile(filename); }
      catch { throw new HTTPError(404, "file not found"); }
      res.writeHead(200, {
        "Content-Type": MIME[extname(filename)] ?? "application/octet-stream",
        "Content-Length": String(content.length),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(method === "HEAD" ? undefined : content);
    } catch (error) {
      const result = errorMessage(error);
      if (result.status === 500) console.error("HTTP request failed:", error);
      json(res, result.status, { error: result.message });
    }
  });
}
