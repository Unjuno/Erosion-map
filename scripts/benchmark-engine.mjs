/**
 * Repeatable performance measurement on deterministic synthetic data.
 * Node and CPU information are emitted to make benchmark conditions explicit.
 */
import { cpus, platform, arch, availableParallelism } from "node:os";
import { performance } from "node:perf_hooks";
import { advanceOneDay, boundsForUserCount } from "../dist/engine.js";
import { nextIsoDay } from "../dist/calendar.js";

const cpu = cpus()[0];
const steps = 65;
const repetitions = 5;
const warmup = 1;
const seed = {
  date: "2026-01-01",
  bounds: boundsForUserCount(0),
  cells: [
    { x: 0, y: 0, char: "海", n: 3 },
    { x: 70, y: 20, char: "森", n: 2 },
    { x: -80, y: -30, char: "文", n: 4 },
  ],
};
const profile = { sameGlyphMode: "max", minimumOutgoingInfluence: 1 };
const samples = [];
let lastCells = 0;
for (let run = 0; run < warmup + repetitions; run++) {
  let state = seed;
  const start = performance.now();
  for (let day = 0; day < steps; day++) {
    state = advanceOneDay(state, nextIsoDay(state.date), profile);
  }
  const elapsed = performance.now() - start;
  lastCells = state.cells.length;
  if (run >= warmup) samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({
  environment: {
    node: process.version, os: platform(), arch: arch(),
    cpuModel: cpu?.model ?? "unknown",
    // OS-reported nominal MHz, not continuously measured clock frequency.
    osReportedCpuMHz: cpu?.speed ?? null,
    logicalCores: availableParallelism(), batch: repetitions,
    warmup, grid: "500x500", seeds: seed.cells.length,
    generationsPerRun: steps, profile,
  },
  medianMilliseconds: Number(median.toFixed(3)),
  minMilliseconds: Number(samples[0].toFixed(3)),
  maxMilliseconds: Number(samples[samples.length - 1].toFixed(3)),
  finalOccupiedCells: lastCells,
}, null, 2));
