/**
 * D1-compatible SQLite integration exercise: 365 published days, one user,
 * one N=1 glyph. This is NOT a real hosted D1/ChatGPT Sites measurement.
 * Logs CPU model, Node version, batch, clock and real SQLite file usage.
 */
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { cpus, platform, arch, availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { D1Store } from "../sites/d1-store.mjs";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys=ON");
for (const path of [
  "migrations/0001_d1_schema.sql",
  "migrations/0002_day_closure.sql",
  "migrations/0003_closed_post_capture.sql",
  "migrations/0004_archival_and_chunked_states.sql",
  "migrations/0005_durable_rate_limits.sql",
  "migrations/0006_immutable_closure_counts.sql",
]) sqlite.exec(await readFile(path, "utf8"));
const adapt = args => args.map(arg =>
  arg instanceof ArrayBuffer ? new Uint8Array(arg) : arg);
const prepared = (sql, values = []) => ({
  bind(...args) { return prepared(sql, args); },
  async first() { return sqlite.prepare(sql).get(...adapt(values)) ?? null; },
  async all() { return { results: sqlite.prepare(sql).all(...adapt(values)) }; },
  async run() {
    const row = sqlite.prepare(sql).run(...adapt(values));
    return { meta: { changes: Number(row.changes) }, success: true };
  },
});
const db = {
  prepare: sql => prepared(sql),
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

const cpu = cpus()[0];
const now = new Date("2027-01-01T00:00:00Z");
const store = new D1Store(db, {
  clock: () => now,
  rulesDefault: { sameGlyphMode: "max", minimumOutgoingInfluence: 1 },
});
let peakRss = process.memoryUsage().rss;
let peakHeap = process.memoryUsage().heapUsed;
try {
  await store.initialize(new Date("2026-01-01T12:00:00Z"));
  await store.registerCredential("benchmark-user", {
    id: "benchmark-passkey", publicKey: new Uint8Array([1, 2]), counter: 0,
  }, true);
  await store.submit("benchmark-user", "2026-01-01", 0, 0, "海");
  const originalPublishDay = store.publishDay.bind(store);
  store.publishDay = async (...args) => {
    const result = await originalPublishDay(...args);
    // Sample after every committed day (not a continuous peak detector).
    const mem = process.memoryUsage();
    peakRss = Math.max(peakRss, mem.rss);
    peakHeap = Math.max(peakHeap, mem.heapUsed);
    return result;
  };
  const started = performance.now();
  // Simulate a catch-up job: 365 daily commits, no intervening new posts.
  const published = await store.publishClosedDays(now, 366);
  const elapsed = performance.now() - started;
  const final = await store.snapshot("2026-12-31");
  const cells = final?.state?.cells;
  if (published.length !== 365 || cells?.length !== 213819 ||
      !cells.every(cell => cell.n === 1 && cell.char === "海")) {
    throw new Error("365-day D1 publication produced an incorrect public map");
  }
  // Limit claims: this measures the backing SQLite schema and the Node
  // process, not the quota/latency of a real D1 service or multiple workers.
  const totals = sqlite.prepare(
    "SELECT COUNT(*) AS days, " +
    "SUM(length(CAST(state_json AS BLOB))) AS storedBytes " +
    "FROM snapshots"
  ).get();
  const chunk = sqlite.prepare(
    "SELECT COALESCE(SUM(length(CAST(chunk_data AS BLOB))),0) AS storedBytes " +
    "FROM snapshot_chunks"
  ).get();
  const page = sqlite.prepare("PRAGMA page_count").get().page_count;
  const pageSize = sqlite.prepare("PRAGMA page_size").get().page_size;
  const mem = process.memoryUsage();
  peakRss = Math.max(peakRss, mem.rss);
  peakHeap = Math.max(peakHeap, mem.heapUsed);
  const result = {
    environment: {
      node: process.version, os: platform(), arch: arch(),
      cpuModel: cpu?.model ?? "unknown",
      osReportedCpuMHz: cpu?.speed > 0 ? cpu.speed : null,
      logicalCores: availableParallelism(),
      grid: "500x500",
      seeds: 1,
      generations: 365,
      repetitions: 1,
      warmup: 0,
      model: "max+N1 floor1",
      persistence: "Node node:sqlite / D1 API emulation",
    },
    elapsedMilliseconds: Math.round(elapsed),
    peakObservedRssMiB: Number((peakRss / 1048576).toFixed(1)),
    peakObservedHeapMiB: Number((peakHeap / 1048576).toFixed(1)),
    snapshots: totals.days,
    finalOccupiedCells: cells.length,
    snapshotTextBytes: totals.storedBytes + chunk.storedBytes,
    sqlitePageBytes: page * pageSize,
    finalRawJsonBytes: Buffer.byteLength(JSON.stringify(final.state), "utf8"),
    orphanedPosts: sqlite.prepare("SELECT COUNT(*) AS n FROM orphaned_posts").get().n,
    identifiedFinalPosts: sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get().n,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.identifiedFinalPosts !== 0 ||
      result.snapshotTextBytes > 50_000_000) {
    throw new Error("published data retention/size exceeded sanity threshold");
  }
} finally {
  sqlite.close();
}
