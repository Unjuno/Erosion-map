import test from "node:test";
import assert from "node:assert/strict";
import { advanceOneDay, boundsForUserCount, resolveCollision } from "../dist/engine.js";
import { nextIsoDay } from "../dist/calendar.js";

test("sum is still the default and max is an explicit experimental choice", () => {
  const claims = [
    { char: "A", n: 3 }, { char: "A", n: 2 }, { char: "B", n: 2 },
  ];
  assert.deepEqual(resolveCollision(claims), { char: "A", n: 3 });
  assert.deepEqual(resolveCollision(claims, { sameGlyphMode: "sum" }),
    { char: "A", n: 3 });
  assert.deepEqual(resolveCollision(claims, { sameGlyphMode: "max" }),
    { char: "A", n: 1 });
});

test("experimental max mode caps N at the previous maximum without new posts", () => {
  let state = {
    date: "2026-01-01", bounds: boundsForUserCount(0),
    cells: [{ x: 0, y: 0, char: "A", n: 3 }],
  };
  const rules = { sameGlyphMode: "max" };
  for (let index = 0; index < 365; index++) {
    const previousMaximum = Math.max(0, ...state.cells.map((cell) => cell.n));
    state = advanceOneDay(state, nextIsoDay(state.date), rules);
    const nextMaximum = Math.max(0, ...state.cells.map((cell) => cell.n));
    assert.ok(nextMaximum <= previousMaximum,
      "N should not increase under max at generation " + (index + 1));
  }
  assert.equal(state.date, "2027-01-01");
  assert.ok(state.cells.length > 0);
  assert.ok(state.cells.every((cell) => cell.n <= 3));
});

test("max rule remains input-order independent and retains cell boundaries", () => {
  const state = {
    date: "2026-10-21", bounds: {
      minX: -2, maxX: 2, minY: -2, maxY: 2,
    },
    cells: [
      { x: -1, y: 0, char: "A", n: 3 },
      { x: 1, y: 0, char: "B", n: 3 },
      { x: 0, y: 1, char: "C", n: 2 },
    ],
  };
  const rules = { sameGlyphMode: "max" };
  const a = advanceOneDay(state, "2026-10-22", rules);
  const b = advanceOneDay({ ...state, cells: [...state.cells].reverse() },
    "2026-10-22", rules);
  assert.deepEqual(a, b);
  assert.ok(a.cells.every((cell) =>
    cell.x >= -2 && cell.x <= 2 && cell.y >= -2 && cell.y <= 2));
});

test("unknown or misspelled collision rule is rejected explicitly", () => {
  assert.throws(() => resolveCollision([{ char: "A", n: 1 }],
    { sameGlyphMode: "product" }), /sameGlyphMode/);
  assert.throws(() => advanceOneDay({
    date: "2026-01-01", bounds: boundsForUserCount(0), cells: [],
  }, "2026-01-02", { sameGlyphMode: "sumx" }), /sameGlyphMode/);
});
