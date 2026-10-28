/**
 * Long-run receiver-engine smoke and resource measurement. This is a Node
 * process, NOT a ChatGPT Sites isolate benchmark or a production load test.
 * No network requests or user data are used.
 */
import { cpus, platform, arch, availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { advanceOneDay, boundsForUserCount } from "../dist/engine.js";
import { nextIsoDay } from "../dist/calendar.js";

const cpu = cpus()[0];
const grid = boundsForUserCount(0);
const profile = { sameGlyphMode: "max", minimumOutgoingInfluence: 1 };
let state = {
  date: "2026-01-01",
  bounds: grid,
  cells: [{ x: 0, y: 0, char: "海", n: 1 }],
};
const generations = 365;
let peakRss = process.memoryUsage().rss;
let peakHeap = process.memoryUsage().heapUsed;
const start = performance.now();
for (let i = 0; i < generations; i++) {
  const next = nextIsoDay(state.date);
  state = advanceOneDay(state, next, profile);
  // A single N=1 glyph can neither decay nor increase in strength under
  // this rule. Any other strength is a correctness regression.
  if (state.cells.some(cell => cell.n !== 1 || cell.char !== "海")) {
    throw new Error("rule mismatch after generation " + (i + 1));
  }
  const mem = process.memoryUsage();
  peakRss = Math.max(peakRss, mem.rss);
  peakHeap = Math.max(peakHeap, mem.heapUsed);
}
const elapsed = performance.now() - start;
const result = {
  environment: {
    node: process.version,
    os: platform(),
    architecture: arch(),
    cpuModel: cpu?.model ?? "unknown",
    osReportedCpuMHz: cpu?.speed > 0 ? cpu.speed : null,
    logicalCores: availableParallelism(),
    grid: "500x500",
    initialSeeds: 1,
    generations,
    repetitions: 1,
    warmup: 0,
    profile,
  },
  elapsedMilliseconds: Math.round(elapsed),
  peakRssMiB: Number((peakRss / 1048576).toFixed(1)),
  peakHeapMiB: Number((peakHeap / 1048576).toFixed(1)),
  finalOccupiedCells: state.cells.length,
  jsonUtf8Bytes: Buffer.byteLength(JSON.stringify(state), "utf8"),
};
console.log(JSON.stringify(result, null, 2));
if (state.date !== "2027-01-01" || state.cells.length < 200000) {
  throw new Error("365-generation scenario did not complete");
}
