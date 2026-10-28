import test from "node:test";
import assert from "node:assert/strict";
import { advanceOneDay, boundsForUserCount, resolveCollision, normalizeGlyph } from "../dist/engine.js";
import { nextIsoDay } from "../dist/calendar.js";

// Independent, deliberately simple oracle for max-grouped receiver semantics.
// It does not use typed arrays, shortcuts, or the production receiver routine.
function referenceTick(previous, date, rules) {
  const b = previous.bounds;
  const cells = new Map();
  for (const cell of previous.cells) {
    if (!Number.isSafeInteger(cell.n) || cell.n < 1) throw new RangeError("invalid strength");
    const key = cell.x + "," + cell.y;
    if (cells.has(key)) throw new RangeError("duplicate");
    cells.set(key, { ...cell, char: normalizeGlyph(cell.char) });
  }
  const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const next = [];
  for (let x = b.minX; x <= b.maxX; x++) {
    for (let y = b.minY; y <= b.maxY; y++) {
      const resident = cells.get(x + "," + y);
      const neighbors = directions.map(([dx, dy]) => cells.get((x + dx) + "," + (y + dy)));
      if (resident && neighbors.every(n => n?.char === resident.char)) {
        next.push(resident);
        continue;
      }
      const claims = resident ? [{ char: resident.char, n: resident.n }] : [];
      for (const n of neighbors) {
        if (!n) continue;
        const strength = Math.max(n.n - 1, rules.minimumOutgoingInfluence);
        if (strength > 0) claims.push({ char: n.char, n: strength });
      }
      const winner = resolveCollision(claims, rules);
      if (winner) next.push({ x, y, ...winner });
    }
  }
  return { date, bounds: { ...b }, cells: next };
}

test("dense receiver path matches the independent reference on many randomized states", () => {
  let seed = 0x6e6f6465;
  function random() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  }
  const bounds = { minX: -4, maxX: 5, minY: -3, maxY: 6 };
  const glyphs = ["A", "B", "海", "👨‍👩‍👧‍👦"];
  for (const floor of [0, 1]) {
    const rules = { sameGlyphMode: "max", minimumOutgoingInfluence: floor };
    for (let caseNumber = 0; caseNumber < 150; caseNumber++) {
      const cells = [];
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        for (let y = bounds.minY; y <= bounds.maxY; y++) {
          if (random() % 5 === 0) {
            cells.push({ x, y, char: glyphs[random() % glyphs.length], n: random() % 9 + 1 });
          }
        }
      }
      if (random() % 2 === 0) cells.reverse();
      const initial = { date: "2026-10-20", bounds, cells };
      const expected = referenceTick(initial, "2026-10-21", rules);
      const received = advanceOneDay(initial, "2026-10-21", rules);
      assert.deepEqual(received, expected, "case " + caseNumber + " floor " + floor);
      assert.deepEqual(initial.cells, cells, "must not mutate previous cells");
    }
  }
});

test("bounded receiver path handles empty, boundaries, and multiple reinforcing neighbors", () => {
  const rules = { sameGlyphMode: "max", minimumOutgoingInfluence: 1 };
  const bounds = { minX: 0, maxX: 1, minY: 0, maxY: 2 };
  for (const cells of [
    [],
    [{ x: 0, y: 0, char: "空", n: 1 }],
    [{ x: 0, y: 0, char: "森", n: 3 }, { x: 1, y: 0, char: "森", n: 2 }],
    [{ x: 0, y: 1, char: "A", n: 2 }, { x: 1, y: 1, char: "B", n: 4 }],
  ]) {
    const snapshot = { date: "2026-10-20", bounds, cells };
    assert.deepEqual(advanceOneDay(snapshot, "2026-10-21", rules),
      referenceTick(snapshot, "2026-10-21", rules));
  }
});

test("bounded receiver does not change the historic sum mode or validation", () => {
  const b = boundsForUserCount(0);
  const world = { date: "2026-10-20", bounds: b, cells: [{ x: 0, y: 0, char: "A", n: 3 }] };
  const legacy = advanceOneDay(world, "2026-10-21");
  const explicit = advanceOneDay(world, "2026-10-21",
    { sameGlyphMode: "sum", minimumOutgoingInfluence: 0 });
  assert.deepEqual(legacy, explicit);
  assert.throws(() => advanceOneDay({ ...world,
    cells: [world.cells[0], world.cells[0]] }, "2026-10-21",
    { sameGlyphMode: "max", minimumOutgoingInfluence: 1 }), /duplicate/);
});
