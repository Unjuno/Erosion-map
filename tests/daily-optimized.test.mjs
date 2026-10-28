import test from "node:test";
import assert from "node:assert/strict";
import { advanceOneDay, boundsForUserCount, resolveCollision } from "../dist/engine.js";
import { buildDailySnapshot, selectFinalPosts } from "../dist/daily.js";

function originalPipeline(previous, records, config) {
  const rules = {
    sameGlyphMode: config.sameGlyphMode ?? "sum",
    minimumOutgoingInfluence: config.minimumOutgoingInfluence ?? 0,
  };
  const wanted = config.registeredUserCount === undefined
    ? previous.bounds : boundsForUserCount(config.registeredUserCount);
  const bounds = {
    minX: Math.min(previous.bounds.minX, wanted.minX),
    maxX: Math.max(previous.bounds.maxX, wanted.maxX),
    minY: Math.min(previous.bounds.minY, wanted.minY),
    maxY: Math.max(previous.bounds.maxY, wanted.maxY),
  };
  const occupants = new Map();
  for (const cell of previous.cells) {
    const id = cell.x + "," + cell.y;
    if (occupants.has(id)) throw new RangeError("duplicate cell");
    occupants.set(id, { ...cell });
  }
  const claims = new Map();
  for (const post of selectFinalPosts(records, config.date)) {
    if (post.x < bounds.minX || post.x > bounds.maxX ||
        post.y < bounds.minY || post.y > bounds.maxY) {
      throw new RangeError("outside bounds");
    }
    const id = post.x + "," + post.y;
    let target = claims.get(id);
    if (!target) {
      target = { x: post.x, y: post.y, claims: [] };
      claims.set(id, target);
    }
    target.claims.push({ char: post.char, n: config.postStrength ?? 1 });
  }
  for (const [id, target] of claims) {
    const incumbent = occupants.get(id);
    const incoming = incumbent ? [{ char: incumbent.char, n: incumbent.n },
      ...target.claims] : target.claims;
    const result = resolveCollision(incoming, rules);
    if (!result) occupants.delete(id);
    else occupants.set(id, { x: target.x, y: target.y, ...result });
  }
  return advanceOneDay({ date: previous.date, bounds,
    cells: [...occupants.values()] }, config.date, rules);
}

test("optimized daily post application matches original copy-on-write pipeline", () => {
  let seed = 0x31415926;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const bounds = { minX: -4, maxX: 6, minY: -5, maxY: 5 };
  const glyphs = ["水", "A", "B", "🌱"];
  const modes = [
    { sameGlyphMode: "sum", minimumOutgoingInfluence: 0 },
    { sameGlyphMode: "max", minimumOutgoingInfluence: 0 },
    { sameGlyphMode: "max", minimumOutgoingInfluence: 1 },
  ];
  for (const mode of modes) {
    for (let i = 0; i < 55; i++) {
      const cells = [];
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        for (let y = bounds.minY; y <= bounds.maxY; y++) {
          if (random() % 6 === 0) {
            cells.push({ x, y, char: glyphs[random() % 4], n: random() % 5 + 1 });
          }
        }
      }
      const records = [];
      for (let u = 0; u < 15; u++) {
        const post = {
          userId: "u" + u, date: "2026-10-21", revision: 1,
          x: bounds.minX + random() % 11,
          y: bounds.minY + random() % 11,
          char: glyphs[random() % glyphs.length],
        };
        records.push(post);
        if (random() % 5 === 0) records.push({
          ...post, revision: 2, char: glyphs[random() % glyphs.length],
        });
      }
      const config = { date: "2026-10-21", postStrength: random() % 2 ? 1 : 3, ...mode };
      const world = { date: "2026-10-20", bounds, cells };
      assert.deepEqual(buildDailySnapshot(world, records, config),
        originalPipeline(world, records, config),
        "random case " + i + " mode " + mode.sameGlyphMode + "/" + mode.minimumOutgoingInfluence);
    }
  }
});

test("no-post days preserve map expansion and reject malformed previous states", () => {
  const bounds = boundsForUserCount(0);
  const previous = { date: "2026-10-20", bounds,
    cells: [{ x: 1, y: 2, char: "森", n: 2 }] };
  for (const mode of [
    { sameGlyphMode: "sum", minimumOutgoingInfluence: 0 },
    { sameGlyphMode: "max", minimumOutgoingInfluence: 1 },
  ]) {
    const config = { date: "2026-10-21", registeredUserCount: 503, ...mode };
    assert.deepEqual(buildDailySnapshot(previous, [], config),
      originalPipeline(previous, [], config));
  }
  const duplicate = { ...previous, cells: [
    previous.cells[0], { ...previous.cells[0] },
  ] };
  assert.throws(() => buildDailySnapshot(duplicate, [], {
    date: "2026-10-21", sameGlyphMode: "max", minimumOutgoingInfluence: 1,
  }), /duplicate/);
  assert.throws(() => buildDailySnapshot(duplicate, [{
    date: "2026-10-21", revision: 1, userId: "u1",
    x: 1, y: 2, char: "A",
  }], {
    date: "2026-10-21", sameGlyphMode: "max", minimumOutgoingInfluence: 1,
  }), /duplicate/);
});
