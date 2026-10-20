import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceOneDay, boundsForUserCount, normalizeGlyph, resolveCollision }
  from '../dist/engine.js';

const bounds = { minX: -2, maxX: 2, minY: -2, maxY: 2 };
const state = (cells, b = bounds) => ({ date: '2026-10-20', bounds: b, cells });
const tick = (cells, b = bounds) => advanceOneDay(state(cells, b), '2026-10-21');
const at = (snapshot, x, y) =>
  snapshot.cells.find((cell) => cell.x === x && cell.y === y) ?? null;

test('500x500 is [-250,249] on each axis', () => {
  assert.deepEqual(boundsForUserCount(10),
    { minX: -250, maxX: 249, minY: -250, maxY: 249 });
});
test('user count extends map, including odd-numbered sizes', () => {
  assert.deepEqual(boundsForUserCount(501),
    { minX: -250, maxX: 250, minY: -250, maxY: 250 });
  assert.throws(() => boundsForUserCount(-1), RangeError);
});
test('one grapheme handles accents and emoji', () => {
  assert.equal(normalizeGlyph('e\u0301'), 'é');
  assert.equal(normalizeGlyph('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');
  assert.throws(() => normalizeGlyph('AB'), RangeError);
});
test('two factions subtract; tie becomes empty', () => {
  assert.deepEqual(resolveCollision([{ char: 'A', n: 3 }, { char: 'B', n: 2 }]),
    { char: 'A', n: 1 });
  assert.equal(resolveCollision([{ char: 'A', n: 2 }, { char: 'B', n: 2 }]), null);
});
test('matching glyphs reinforce', () => {
  assert.deepEqual(resolveCollision([
    { char: 'A', n: 2 }, { char: 'B', n: 3 }, { char: 'A', n: 3 }
  ]), { char: 'A', n: 2 });
});
test('three-way collision independent of input order', () => {
  const claims = [{ char: 'A', n: 6 }, { char: 'B', n: 2 }, { char: 'C', n: 1 }];
  assert.deepEqual(resolveCollision(claims), { char: 'A', n: 3 });
  assert.deepEqual(resolveCollision([...claims].reverse()), { char: 'A', n: 3 });
  assert.equal(resolveCollision([
    { char: 'A', n: 4 }, { char: 'B', n: 3 }, { char: 'C', n: 3 }
  ]), null);
});
test('N=3 seed spreads to 4 neighbors with strength 2', () => {
  const result = tick([{ x: 0, y: 0, char: 'A', n: 3 }]);
  for (const [x, y] of [[1,0], [-1,0], [0,1], [0,-1]])
    assert.deepEqual(at(result, x, y), { x, y, char: 'A', n: 2 });
  assert.deepEqual(at(result, 0, 0), { x: 0, y: 0, char: 'A', n: 3 });
  assert.equal(result.cells.length, 5);
});
test('N=1 does not expand (product-design issue)', () => {
  assert.deepEqual(tick([{ x: 0, y: 0, char: 'A', n: 1 }]).cells,
    [{ x: 0, y: 0, char: 'A', n: 1 }]);
});
test('one generation per day, never cascading in the same tick', () => {
  assert.equal(at(tick([{ x: 0, y: 0, char: 'A', n: 3 }]), 2, 0), null);
});
test('resident defends with its own strength', () => {
  assert.deepEqual(at(tick([
    { x: 0, y: 0, char: 'A', n: 2 },
    { x: 1, y: 0, char: 'B', n: 4 }
  ]), 0, 0), { x: 0, y: 0, char: 'B', n: 1 });
});
test('fully surrounded cell holds its original strength', () => {
  const seed = { x: 0, y: 0, char: 'A', n: 1 };
  const cells = [seed, ...[[-1,0], [1,0], [0,-1], [0,1]]
    .map(([x, y]) => ({ x, y, char: 'A', n: 4 }))];
  assert.deepEqual(at(tick(cells), 0, 0), seed);
});
test('state independent of cell input order', () => {
  const cells = [
    { x: -1, y: 0, char: 'A', n: 3 },
    { x: 1, y: 0, char: 'B', n: 3 },
    { x: 0, y: 1, char: 'C', n: 2 }
  ];
  assert.deepEqual(tick(cells), tick([...cells].reverse()));
  assert.equal(at(tick(cells), 0, 0), null);
});
test('map edge clips outgoing influence', () => {
  const b = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  assert.deepEqual(tick([{ x: 0, y: 0, char: 'A', n: 5 }], b).cells,
    [{ x: 0, y: 0, char: 'A', n: 5 }]);
});
test('duplicate coordinates and invalid strength fail fast', () => {
  const seed = { x: 0, y: 0, char: 'A', n: 2 };
  assert.throws(() => tick([seed, seed]), /duplicate/);
  assert.throws(() => tick([{ ...seed, n: 0 }]), RangeError);
  assert.throws(() => resolveCollision([{ char: 'A', n: -1 }]), RangeError);
});
test('input snapshot is not mutated', () => {
  const seed = Object.freeze({ x: 0, y: 0, char: 'A', n: 3 });
  const before = Object.freeze({
    date: '2026-10-20', bounds: Object.freeze({ ...bounds }),
    cells: Object.freeze([seed])
  });
  advanceOneDay(before, '2026-10-21');
  assert.equal(before.cells[0].n, 3);
});


test("invalid dates and invisible characters fail validation", () => {
  assert.throws(() => advanceOneDay({
    date: "2026-02-30", bounds, cells: [],
  }, "2026-03-01"), /invalid ISO/);
  assert.throws(() => advanceOneDay({
    date: "2026-02-28", bounds, cells: [],
  }, "2026-02-30"), /invalid ISO/);
  assert.throws(() => normalizeGlyph(" "), /invisible/);
  assert.throws(() => normalizeGlyph("\u0000"), /invisible/);
  assert.equal(normalizeGlyph("👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦");
});

test("same-character reinforcement grows rapidly under provisional rules", () => {
  let snapshot = {
    date: "2026-01-01", bounds: boundsForUserCount(0),
    cells: [{ x: 0, y: 0, char: "A", n: 3 }],
  };
  for (let i = 0; i < 20; i++) {
    const next = new Date(Date.parse(snapshot.date + "T00:00:00Z") + 86_400_000)
      .toISOString().slice(0, 10);
    snapshot = advanceOneDay(snapshot, next);
  }
  assert.ok(Math.max(...snapshot.cells.map((cell) => cell.n) > 1_000_000);
});
