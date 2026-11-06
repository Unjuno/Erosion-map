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
  let response;
  try {
    response = await fetcher(url, { credentials: "same-origin", cache: "no-store" });
  } catch (cause) {
    throw new ArchiveError("transport", "snapshot request failed", cause);
  }
  if (!response.ok) {
    throw new ArchiveError(response.status === 404 ? "integrity" : "transport",
      "snapshot endpoint failed for " + record.date + ": HTTP " + response.status);
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ArchiveError("integrity", "snapshot endpoint returned non-JSON data");
  }
  let payload;
  let raw;
  try {
    raw = await response.text();
    payload = JSON.parse(raw);
  } catch (cause) {
    throw new ArchiveError("integrity", "snapshot contains malformed JSON", cause);
  }
  const state = wrapped ? payload?.state : payload;
  try { validateSnapshot(state, record.date); }
  catch (cause) {
    throw new ArchiveError("integrity", "invalid published snapshot structure", cause);
  }
  const source = wrapped ? JSON.stringify(state) : raw;
  const expected = record.sha256;
  if (wrapped && payload.sha256 !== expected) {
    throw new ArchiveError("integrity", "API hash disagrees with history index");
  }
  let actual;
  try { actual = await computeDigest(source, cryptoProvider); }
  catch (cause) {
    throw new ArchiveError("environment", "snapshot verification could not run", cause);
  }
  if (actual !== expected) {
    throw new ArchiveError("integrity", "snapshot SHA-256 mismatch for " + record.date);
  }
  return state;
}
async function load(fetcher, cryptoProvider, limit, kind, onSnapshot = null) {
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
  // Callers computing rankings should not keep 30 full snapshots in memory.
  // Deliver each authenticated state in chronological order, discarding it
  // immediately after aggregation; the interactive timeline still requests
  // its smaller window as an array.
  const batchSize = onSnapshot ? 1 : 4;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const subset = await Promise.all(batch.map((record) =>
      fetchState(fetcher,
        isAPI ? "./api/state?date=" + encodeURIComponent(record.date)
              : "./data/state-" + record.date + ".json",
        record, cryptoProvider, isAPI)));
    for (const state of subset) {
      if (onSnapshot) await onSnapshot(state);
      else states.push(state);
    }
  }
  return { source: isAPI ? "api" : "static", states, loadedDays: records.length };
}
async function verifiedArchive({
  fetcher = fetch,
  cryptoProvider = globalThis.crypto,
  limit = 21,
  onSnapshot = null,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new RangeError("archive limit must be 1..30");
  }
  let firstFailure;
  try {
    return await load(fetcher, cryptoProvider, limit, "api", onSnapshot);
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
    return await load(fetcher, cryptoProvider, limit, "static", onSnapshot);
  } catch (error) {
    if (error instanceof ArchiveError) {
      if (error.kind === "absent") {
        throw new ArchiveError("empty", "no finalized daily archive exists yet", error);
      }
      throw error; // static integrity/transport problems are terminal too
    }
    throw new ArchiveError("integrity",
      "the static archive could not be verified after the API was absent", error);
  }
}

/** Interactive timeline: retain its short verified history window. */
export async function loadPublishedArchive(options = {}) {
  return verifiedArchive(options);
}

/**
 * Streaming verified archive visitor for aggregate screens. Each full state
 * is released before the next day is fetched, avoiding a retained 30-day map
 * array when only historical presence counts are required.
 */
export async function visitPublishedArchive(options = {}) {
  if (typeof options.onSnapshot !== "function") {
    throw new TypeError("onSnapshot callback is required");
  }
  return verifiedArchive(options);
}
