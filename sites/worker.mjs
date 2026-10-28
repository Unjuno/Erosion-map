/**
 * Cloudflare-style worker entrypoint for ChatGPT Sites D1 + static assets.
 *
 * Deployment requires:
 *   env.DB: D1 binding, migration 0001_d1_schema.sql applied
 *   env.ASSETS: static assets binding for site/
 *   env.PUBLIC_ORIGIN: final HTTPS origin, never derived from Host headers
 *   env.RP_ID: same hostname or a legitimate parent domain
 *
 * A scheduled trigger is supported when the host provides one. When it does
 * not, reading the public map opportunistically catches up one closed day.
 */
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { Buffer } from "node:buffer";
import { D1Store, hashText } from "./d1-store.mjs";
import { dayAtInstant } from "../dist/calendar.js";

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function configuration(env) {
  if (!env?.DB?.prepare || !env?.DB?.batch) {
    throw new Error("D1 binding DB is missing");
  }
  const requestedOrigin = env.PUBLIC_ORIGIN;
  if (typeof requestedOrigin !== "string") {
    throw new Error("PUBLIC_ORIGIN must be configured");
  }
  const u = new URL(requestedOrigin);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error("PUBLIC_ORIGIN must use HTTPS outside localhost");
  }
  if (requestedOrigin !== u.origin) {
    throw new Error("PUBLIC_ORIGIN must be a bare origin without path or slash");
  }
  const rpID = env.RP_ID;
  if (typeof rpID !== "string" || rpID.length < 3 ||
      !(rpID === u.hostname || u.hostname.endsWith("." + rpID))) {
    throw new Error("RP_ID must match the public origin");
  }
  // Sites v1 candidate defaults to a bounded, playable ruleset.
  // Historical "sum/N-1" remains available by explicit configuration.
  // This is an intentional, documented resolution of the contradictory
  // default post N=1 + outgoing (N-1) product requirements.
  const mode = env.SAME_GLYPH_MODE ?? "max";
  const floor = env.N1_OUTBOUND === undefined ? 1 : Number(env.N1_OUTBOUND);
  if (!["sum", "max"].includes(mode) || ![0, 1].includes(floor) ||
      (floor === 1 && mode !== "max")) {
    throw new Error("invalid trusted erosion rule settings");
  }
  return { origin: u.origin, rpID, secure: !local || u.protocol === "https:",
    rulesDefault: { sameGlyphMode: mode, minimumOutgoingInfluence: floor } };
}
function json(status, payload, cookies = []) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}
function token() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
function parseCookies(header) {
  const output = new Map();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1) output.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return output;
}
function cookieName(type, secure) {
  return (secure ? "__Host-erosion-" : "erosion_") + type;
}
function setCookie(name, value, secure, ageSeconds) {
  return name + "=" + value + "; Path=/; HttpOnly; SameSite=Strict" +
    (secure ? "; Secure" : "") + "; Max-Age=" + ageSeconds;
}
async function bodyJSON(request) {
  const maxBytes = 65_536;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > maxBytes) {
    throw new RequestError(413, "request too large");
  }
  if (!request.body) throw new RequestError(400, "JSON object required");
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("request too large");
        throw new RequestError(413, "request too large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let index = 0;
  for (const part of parts) {
    bytes.set(part, index);
    index += part.byteLength;
  }
  let decoded;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "invalid JSON");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new RequestError(400, "JSON object required");
  }
  return decoded;
}
async function guardedVerify(callback) {
  try { return await callback(); }
  catch { throw new RequestError(400, "passkey verification failed"); }
}
function assertionUserHandle(payload, expected) {
  const handle = payload?.credential?.response?.userHandle;
  if (handle === undefined || handle === null) return;
  if (typeof handle !== "string" || !/^[a-zA-Z0-9_-]+$/.test(handle) ||
      !Buffer.from(handle, "base64url").equals(Buffer.from(expected, "utf8"))) {
    throw new RequestError(400, "credential user handle mismatch");
  }
}

/** Exported separately for direct request tests in Node. */
export async function handleRequest(request, env, context = {}) {
  let conf;
  try { conf = configuration(env); }
  catch {
    return json(503, { error: "site infrastructure is not configured" });
  }
  const store = new D1Store(env.DB, {
    clock: () => context.now?.() ?? new Date(),
    rulesDefault: conf.rulesDefault,
  });
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const sessionName = cookieName("session", conf.secure);
  const challengeName = cookieName("challenge", conf.secure);
  const cookies = parseCookies(request.headers.get("cookie"));
  const sessionToken = cookies.get(sessionName);
  const challengeToken = cookies.get(challengeName);
  const userSession = async () => sessionToken
    ? store.userForSession(await hashText(sessionToken)) : null;
  const requireUser = async () => {
    const found = await userSession();
    if (!found) throw new RequestError(401, "passkey login required");
    return found;
  };
  const consume = async (kind) => {
    if (!challengeToken) throw new RequestError(400, "missing challenge");
    const found = await store.consumeChallenge(await hashText(challengeToken), kind);
    if (!found) throw new RequestError(400, "challenge expired or used");
    return found;
  };
  const mint = async (userId) => {
    if (sessionToken) await store.revokeSession(await hashText(sessionToken));
    const generated = token();
    await store.issueSession(await hashText(generated), userId);
    return setCookie(sessionName, generated, conf.secure, 7 * 24 * 3600);
  };
  const invalidateChallenge = () => setCookie(challengeName, "", conf.secure, 0);
  const verifyAssertion = async (payload, pending, expectedUserId = null) => {
    const credential = await store.credentialById(payload?.credential?.id);
    if (!credential) throw new RequestError(400, "unknown passkey");
    if (expectedUserId !== null && credential.userId !== expectedUserId) {
      throw new RequestError(400, "wrong account for passkey");
    }
    assertionUserHandle(payload, credential.userId);
    const verified = await guardedVerify(() => verifyAuthenticationResponse({
      response: payload.credential, expectedChallenge: pending.challenge,
      expectedOrigin: conf.origin, expectedRPID: conf.rpID,
      credential: {
        id: credential.id, publicKey: credential.publicKey,
        counter: credential.counter, transports: credential.transports,
      },
      requireUserVerification: true,
    }));
    if (!verified.verified || !verified.authenticationInfo) {
      throw new RequestError(400, "passkey authentication failed");
    }
    await store.updateCounter(credential.id, credential.counter,
      verified.authenticationInfo.newCounter);
    return credential.userId;
  };

  try {
    if (!path.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!env.ASSETS?.fetch) {
        return json(503, { error: "static assets not configured" });
      }
      const aliases = {
        "/submit": "/account.html", "/ranking": "/ranking.html",
        "/policy": "/policy.html", "/": "/index.html",
      };
      const destination = new URL(request.url);
      destination.pathname = aliases[path] ?? path;
      const response = await env.ASSETS.fetch(new Request(destination, request));
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      return new Response(method === "HEAD" ? null : response.body,
        { status: response.status, headers });
    }
    if (method !== "GET" && method !== "HEAD") {
      if (request.headers.get("origin") !== conf.origin) {
        throw new RequestError(403, "invalid request origin");
      }
      if (!request.headers.get("content-type")?.toLowerCase()
        .startsWith("application/json")) {
        throw new RequestError(415, "application/json required");
      }
    }
    if (path === "/api/status" && method === "GET") {
      await store.initialize();
      // Opportunistic fallback when the Sites runtime has no cron trigger.
      // Limit to one day per request; scheduled events can catch up faster.
      await store.publishClosedDays(undefined, 1);
      return json(200, { mode: "sites-d1",
        latestDay: (await store.latestState())?.date ?? null });
    }
    if (path === "/api/state" && method === "GET") {
      await store.initialize();
      await store.publishClosedDays(undefined, 1);
      const date = url.searchParams.get("date");
      const day = date ?? (await store.latestState())?.date;
      const entry = day ? await store.snapshot(day) : null;
      if (!entry) throw new RequestError(404, "snapshot unavailable");
      return json(200, { state: entry.state, sha256: entry.sha256 });
    }
    if (path === "/api/history" && method === "GET") {
      await store.initialize();
      return json(200, { days: await store.days(180) });
    }
    if (path === "/api/me" && method === "GET") {
      const userId = await userSession();
      const day = dayAtInstant(store.clock());
      return userId
        ? json(200, { authenticated: true, userId, day,
          credentialCount: (await store.credentialsByUser(userId)).length,
          post: await store.currentPost(userId, day) })
        : json(200, { authenticated: false, day });
    }
    if (path === "/api/auth/register/start" && method === "POST") {
      await bodyJSON(request);
      const active = await userSession();
      const userId = active ?? crypto.randomUUID();
      const excludes = active ? await store.credentialsByUser(active) : [];
      const options = await generateRegistrationOptions({
        rpName: "Erosion Map", rpID: conf.rpID,
        userName: "erosion-" + userId.slice(0, 8),
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required", userVerification: "required",
        },
        excludeCredentials: excludes.map((credential) => ({
          id: credential.id, transports: credential.transports,
        })),
      });
      const pending = token();
      await store.issueChallenge(await hashText(pending),
        "register", options.challenge, userId);
      return json(200, { options }, [
        setCookie(challengeName, pending, conf.secure, 300),
      ]);
    }
    if (path === "/api/auth/register/finish" && method === "POST") {
      const payload = await bodyJSON(request);
      const pending = await consume("register");
      const existing = await store.hasUser(pending.userId);
      if (existing && (await userSession()) !== pending.userId) {
        throw new RequestError(403, "active session required to add passkey");
      }
      const verified = await guardedVerify(() => verifyRegistrationResponse({
        response: payload.credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: conf.origin, expectedRPID: conf.rpID,
        requireUserVerification: true,
      }));
      if (!verified.verified || !verified.registrationInfo) {
        throw new RequestError(400, "registration failed");
      }
      await store.registerCredential(pending.userId, verified.registrationInfo.credential,
        !existing);
      return json(200, { authenticated: true }, [
        invalidateChallenge(), await mint(pending.userId),
      ]);
    }
    if (path === "/api/auth/login/start" && method === "POST") {
      await bodyJSON(request);
      const options = await generateAuthenticationOptions({
        rpID: conf.rpID, userVerification: "required", allowCredentials: [],
      });
      const pending = token();
      await store.issueChallenge(await hashText(pending),
        "authenticate", options.challenge);
      return json(200, { options }, [
        setCookie(challengeName, pending, conf.secure, 300),
      ]);
    }
    if (path === "/api/auth/login/finish" && method === "POST") {
      const payload = await bodyJSON(request);
      const pending = await consume("authenticate");
      if (pending.userId !== null) throw new RequestError(400, "wrong challenge kind");
      const userId = await verifyAssertion(payload, pending);
      return json(200, { authenticated: true }, [
        invalidateChallenge(), await mint(userId),
      ]);
    }
    if (path === "/api/account/delete/start" && method === "POST") {
      const userId = await requireUser();
      await bodyJSON(request);
      const options = await generateAuthenticationOptions({
        rpID: conf.rpID, userVerification: "required",
        allowCredentials: (await store.credentialsByUser(userId)).map((credential) => ({
          id: credential.id, transports: credential.transports,
        })),
      });
      const pending = token();
      await store.issueChallenge(await hashText(pending),
        "authenticate", options.challenge, userId);
      return json(200, { options }, [
        setCookie(challengeName, pending, conf.secure, 300),
      ]);
    }
    if (path === "/api/account/delete/finish" && method === "POST") {
      const userId = await requireUser();
      const body = await bodyJSON(request);
      if (body.confirm !== "DELETE") throw new RequestError(400, "confirm deletion");
      const pending = await consume("authenticate");
      if (pending.userId !== userId) throw new RequestError(400, "account mismatch");
      await verifyAssertion(body, pending, userId);
      await store.deleteUser(userId);
      return json(200, { deleted: true }, [
        invalidateChallenge(),
        setCookie(sessionName, "", conf.secure, 0),
      ]);
    }
    if (path === "/api/auth/logout" && method === "POST") {
      await bodyJSON(request);
      if (sessionToken) await store.revokeSession(await hashText(sessionToken));
      return json(200, { authenticated: false }, [
        setCookie(sessionName, "", conf.secure, 0),
      ]);
    }
    if (path === "/api/post" && method === "POST") {
      const userId = await requireUser();
      const body = await bodyJSON(request);
      const day = dayAtInstant(store.clock());
      const saved = await store.submit(userId, day, body.x, body.y, body.char);
      return json(200, { saved });
    }
    throw new RequestError(404, "API route not found");
  } catch (error) {
    if (error instanceof RequestError) {
      return json(error.code, { error: error.message });
    }
    if (error instanceof RangeError || error instanceof SyntaxError) {
      return json(400, { error: error.message });
    }
    console.error("site request failed", error);
    return json(500, { error: "internal error" });
  }
}
export default {
  fetch: handleRequest,
  async scheduled(_event, env, context) {
    const conf = configuration(env);
    const store = new D1Store(env.DB, { rulesDefault: conf.rulesDefault });
    context.waitUntil(store.publishClosedDays(new Date(), 32));
  },
};
