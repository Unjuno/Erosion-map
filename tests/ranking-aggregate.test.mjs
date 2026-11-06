import test from "node:test";
import assert from "node:assert/strict";
import { createRankingAccumulator } from "../public/ranking-aggregate.js";

function reference(states) {
  const latest = states.at(-1);
  const totals = new Map();
  for (const cell of latest.cells) {
    const item = totals.get(cell.char) ?? { cells: 0, strength: 0, days: 0 };
    item.cells++;
    item.strength += cell.n;
    totals.set(cell.char, item);
  }
  for (const state of states) {
    for (const char of new Set(state.cells.map(cell => cell.char))) {
      if (totals.has(char)) totals.get(char).days++;
    }
  }
  return {
    date: latest.date, occupied: latest.cells.length, days: states.length,
    entries: [...totals].map(([char, values]) => ({ char, ...values })),
  };
}

test("incremental ranking equals the original all-snapshots algorithm", () => {
  let seed = 0x6a4b2c1d;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed >>> 0;
  };
  const chars = ["海", "森", "光", "空", "👨‍👩‍👧‍👦"];
  for (let iteration = 0; iteration < 40; iteration++) {
    const states = Array.from({ length: 12 }, (_, index) => ({
      date: "2026-10-" + String(index + 1).padStart(2, "0"),
      cells: Array.from({ length: random() % 30 }, () => ({
        char: chars[random() % chars.length], n: random() % 9 + 1,
      })),
    }));
    const counter = createRankingAccumulator();
    for (const state of states) counter.accept(state);
    assert.deepEqual(counter.result(), reference(states));
  }
});

test("ranking projection does not depend on retaining old cell arrays", () => {
  const counter = createRankingAccumulator();
  const previous = { date: "2026-10-20", cells: [
    { char: "森", n: 2 }, { char: "海", n: 3 },
  ] };
  counter.accept(previous);
  previous.cells.length = 0;
  counter.accept({ date: "2026-10-21", cells: [
    { char: "海", n: 1 }, { char: "海", n: 5 },
  ] });
  assert.deepEqual(counter.result(), {
    date: "2026-10-21", occupied: 2, days: 2,
    entries: [{ char: "海", cells: 2, strength: 6, days: 2 }],
  });
});

test("ranking refuses out-of-order days and non-finite strength", () => {
  const counter = createRankingAccumulator();
  counter.accept({ date: "2026-10-20", cells: [] });
  assert.throws(() => counter.accept({ date: "2026-10-20", cells: [] }), /day order/);
  assert.throws(() => counter.accept({ date: "2026-10-21", cells: [
    { char: "海", n: Number.POSITIVE_INFINITY },
  ] }), /invalid ranking cell/);
});
