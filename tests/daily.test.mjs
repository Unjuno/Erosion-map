import test from "node:test";
import assert from "node:assert/strict";
import { buildDailySnapshot, selectFinalPosts } from "../dist/daily.js";

const b = { minX: -2, maxX: 2, minY: -2, maxY: 2 };
const before = (cells = []) => ({ date: "2026-10-20", bounds: b, cells });
const post = (userId, revision, char, x = 0, y = 0) => ({
  userId, revision, char, x, y, date: "2026-10-21",
});
const build = (old, records = [], extra = {}) =>
  buildDailySnapshot(old, records, { date: "2026-10-21", ...extra });
const at = (result, x = 0, y = 0) =>
  result.cells.find((cell) => cell.x === x && cell.y === y) ?? null;

test("empty daily inputs produce the same tick as the engine", () => {
  const result = build(before([{ x: 0, y: 0, char: "A", n: 3 }]));
  assert.deepEqual(at(result, 1, 0), { x: 1, y: 0, char: "A", n: 2 });
});

test("a single normal N=1 post persists without expanding", () => {
  const result = build(before(), [post("user1", 1, "日")]);
  assert.deepEqual(result.cells, [{ x: 0, y: 0, char: "日", n: 1 }]);
});

test("the last revision wins, regardless of array order", () => {
  const records = [post("alice", 1, "A"), post("alice", 3, "C", 1, 0),
    post("alice", 2, "B", -1, 0)];
  assert.deepEqual(selectFinalPosts(records, "2026-10-21"),
    selectFinalPosts([...records].reverse(), "2026-10-21"));
  const result = build(before(), records);
  assert.equal(at(result, 0, 0), null);
  assert.equal(at(result, -1, 0), null);
  assert.deepEqual(at(result, 1, 0), { x: 1, y: 0, char: "C", n: 1 });
});

test("duplicate user/day/revision fails rather than choosing by input order", () => {
  assert.throws(() => selectFinalPosts([post("a", 1, "A"), post("a", 1, "B")],
    "2026-10-21"), /reused/);
});

test("different users' conflicting posts cancel deterministically", () => {
  assert.equal(at(build(before(), [post("a", 1, "A"), post("b", 1, "B")])), null);
  assert.equal(at(build(before(), [post("b", 1, "B"), post("a", 1, "A")])), null);
});

test("identical posts reinforce the same character", () => {
  assert.deepEqual(at(build(before(), [post("a", 1, "A"), post("b", 1, "A")])),
    { x: 0, y: 0, char: "A", n: 2 });
});

test("incumbent participates when new posts target an occupied square", () => {
  const result = build(before([{ x: 0, y: 0, char: "A", n: 3 }]),
    [post("b", 1, "B")]);
  assert.equal(at(result, 0, 0)?.char, "A");
});

test("an event grants greater server-defined strength", () => {
  const result = build(before(), [post("alice", 1, "A")], { postStrength: 3 });
  assert.deepEqual(at(result, 1, 0), { x: 1, y: 0, char: "A", n: 2 });
});

test("large registered user count expands without relocating the origin", () => {
  const result = build(before([{ x: 0, y: 0, char: "A", n: 1 }]), [],
    { registeredUserCount: 501 });
  assert.deepEqual(result.bounds, { minX: -250, maxX: 250, minY: -250, maxY: 250 });
  assert.deepEqual(at(result), { x: 0, y: 0, char: "A", n: 1 });
});

test("out-of-bounds posting is rejected", () => {
  assert.throws(() => build(before(), [post("alice", 1, "A", 3, 0)]), /outside/);
});

test("only the next calendar day can be generated", () => {
  assert.throws(() => buildDailySnapshot(before(), [],
    { date: "2026-10-22" }), /exactly one/);
});

test("input order never changes the published snapshot", () => {
  const records = [post("a", 1, "A", -1, 0), post("b", 1, "B", 1, 0)];
  const forward = build(before(), records, { postStrength: 4 });
  assert.deepEqual(forward, build(before(), [...records].reverse(), { postStrength: 4 }));
});

test("client cannot supply per-post N", () => {
  const forged = { ...post("user", 1, "A"), n: 500 };
  const result = build(before(), [forged]);
  assert.deepEqual(at(result), { x: 0, y: 0, char: "A", n: 1 });
});

test("previous state remains immutable", () => {
  const cells = Object.freeze([{ x: 0, y: 0, char: "A", n: 3 }]);
  const previous = Object.freeze({ date: "2026-10-20", bounds: Object.freeze(b), cells });
  build(previous, [post("a", 1, "B", 2, 2)]);
  assert.equal(previous.cells.length, 1);
});
