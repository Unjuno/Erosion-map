/**
 * Browser/Node-compatible published history loader. Never returns private DB data.
 * Public JSON SHA-256 hashes are checked against the authoritative index/API.
 */
import { assertIsoDay } from "./calendar.js";

/**
 * The archive boundary is a state machine, not a generic try/fallback.
 * Only an ABSENT API endpoint authorizes loading a static archive.
 * A present API with broken hashes, invalid JSON, or server failure must
 * never silently downgrade to stale demo/static data.
 */
export class ArchiveError extends Error {
  constructor(kind, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArchiveError";
    this.kind = kind;
  }
}


function assertIndexEntry(value) {
  const date = value?.date ?? value?.day;
  assertIsoDay(date);
  if (typeof value?.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new RangeError("published archive requires SHA-256 metadata");
  }
  return { date, sha256: value.sha256 };
}
async function fetchJSON(fetcher, path) {
  let response;
  try {
    response = await fetcher(path, { credentials: "same-origin", cache: "no-store" });
  } catch (cause) {
    throw new ArchiveError("transport", "archive request failed", cause);
  }
  if (response.status === 404 || response.status === 501) {
    throw new ArchiveError("absent", "archive endpoint is not installed");
  }
  if (!response.ok) {
    throw new ArchiveError("transport", "archive endpoint failed: HTTP " + response.status);
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ArchiveError("integrity", "archive endpoint returned a non-JSON response");
  }
  try { return await response.json(); }
  catch (cause) {
    throw new ArchiveError("integrity", "archive index contains invalid JSON", cause);
  }
}
function validateSnapshot(state, date) {
  if (state?.date !== date || !state.bounds ||
      !Array.isArray(state.cells)) {
    throw new Error("invalid or mismatched published snapshot");
  }
  const b = state.bounds;
  if (![b.minX, b.maxX, b.minY, b.maxY].every(Number.isSafeInteger) ||
      b.minX > b.maxX || b.minY > b.maxY) {
    throw new Error("invalid map bounds");
  }
  for (const cell of state.cells) {
    if (typeof cell.char !== "string" || !Number.isSafeInteger(cell.n) ||
        cell.n < 1 || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y) ||
        cell.x < b.minX || cell.x > b.maxX ||
        cell.y < b.minY || cell.y > b.maxY) {
      throw new Error("invalid published cell");
    }
  }
}
async function computeDigest(raw, webCrypto) {
  if (!webCrypto?.subtle?.digest) {
    throw new Error("Web Crypto SHA-256 requires a secure origin");
  }
  const bytes = new TextEncoder().encode(raw);
  const digest = await webCrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}
async function fetchState(fetcher, url, record, cryptoProvider, wrapped) {
  const response = await fetcher(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("snapshot file is unavailable");
  }
  const raw = await response.text();
  const payload = JSON.parse(raw);
  const state = wrapped ? payload.state : payload;
  validateSnapshot(state, record.date);
  const source = wrapped ? JSON.stringify(state) : raw;
  const expected = record.sha256;
  if (wrapped && payload.sha256 !== expected) {
    throw new Error("API hash disagrees with history index");
  }
  if (await computeDigest(source, cryptoProvider) !== expected) {
    throw new Error("snapshot SHA-256 mismatch for " + record.date);
  }
  return state;
}
async function load(fetcher, cryptoProvider, limit, kind) {
  const isAPI = kind === "api";
  const index = await fetchJSON(fetcher,
    isAPI ? "./api/history" : "./data/index.json");
  const entries = isAPI ? index.days : index;
  if (!Array.isArray(entries)) {
    throw new ArchiveError("integrity", "archive index has an invalid structure");
  }
  if (entries.length === 0) {
    throw new ArchiveError("empty", "no finalized daily archive exists yet");
  }
  const selection = isAPI ? entries.slice(0, limit).reverse() : entries.slice(-limit);
  const records = selection.map(assertIndexEntry);
  const states = [];
  for (let i = 0; i < records.length; i += 4) {
    const batch = records.slice(i, i + 4);
    const subset = await Promise.all(batch.map((record) =>
      fetchState(fetcher,
        isAPI ? "./api/state?date=" + encodeURIComponent(record.date)
              : "./data/state-" + record.date + ".json",
        record, cryptoProvider, isAPI)));
    states.push(...subset);
  }
  return { source: isAPI ? "api" : "static", states };
}
export async function loadPublishedArchive({
  fetcher = fetch,
  cryptoProvider = globalThis.crypto,
  limit = 21,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new RangeError("archive limit must be 1..30");
  }
  let firstFailure;
  try {
    return await load(fetcher, cryptoProvider, limit, "api");
  } catch (error) {
    // A valid API history index is authoritative. Integrity failures,
    // transient service outages, or even a legitimately empty history may
    // not be replaced by a static fallback masquerading as current data.
    if (!(error instanceof ArchiveError) || error.kind !== "absent") {
      throw error;
    }
    firstFailure = error;
  }
  try {
    return await load(fetcher, cryptoProvider, limit, "static");
  } catch (error) {
    if (error instanceof ArchiveError && error.kind === "absent") {
      throw new ArchiveError("empty", "no finalized daily archive exists yet", error);
    }
    throw new AggregateError([firstFailure, error],
      "neither API nor static archive could be verified");
  }
}
