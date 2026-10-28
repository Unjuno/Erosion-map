/**
 * Browser/Node-compatible published history loader. Never returns private DB data.
 * Public JSON SHA-256 hashes are checked against the authoritative index/API.
 */
import { assertIsoDay } from "./calendar.js";

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
  const response = await fetcher(path, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("archive endpoint is unavailable");
  }
  return response.json();
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
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("archive is empty");
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
    firstFailure = error;
  }
  try {
    return await load(fetcher, cryptoProvider, limit, "static");
  } catch (error) {
    throw new AggregateError([firstFailure, error],
      "neither API nor static archive could be verified");
  }
}
