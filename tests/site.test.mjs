import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { advanceOneDay, boundsForUserCount } from "../dist/engine.js";
import { buildDailySnapshot } from "../dist/daily.js";
import { nextIsoDay } from "../dist/calendar.js";

test("site bundle contains all offline-loadable assets", async () => {
  for (const name of ["index.html", "styles.css", "app.js",
    "engine.js", "daily.js", "calendar.js", "ranking.html", "ranking.css", "ranking.js", "demo-data.js", "archive.js", "policy.html", "policy.css"]) {
    const result = await stat(join("site", name));
    assert.ok(result.size > 0, name);
  }
  const html = await readFile(join("site", "index.html"), "utf8");
  assert.match(html, /id="mapCanvas"/);
  assert.match(html, /type="module" src="\.\/app\.js"/);
});

test("demo evolves for thirteen days without overflow or duplicate coordinates", () => {
  let snapshot = {
    date: "2026-10-01",
    bounds: boundsForUserCount(0),
    cells: [
      { x: -9, y: -3, char: "文", n: 7 },
      { x: 9, y: -5, char: "海", n: 7 },
      { x: 2, y: 9, char: "森", n: 6 },
      { x: -12, y: 9, char: "星", n: 6 },
      { x: 1, y: 0, char: "光", n: 5 },
    ],
  };
  for (let step = 1; step <= 12; step++) {
    snapshot = advanceOneDay(snapshot, nextIsoDay(snapshot.date));
    const coordinates = new Set(snapshot.cells.map((cell) => cell.x + "," + cell.y));
    assert.equal(coordinates.size, snapshot.cells.length);
    assert.ok(snapshot.cells.every((cell) => Number.isSafeInteger(cell.n) && cell.n >= 1));
  }
  assert.equal(snapshot.date, "2026-10-13");
});

test("preview posts can be inserted into day two and recomputed", () => {
  const initial = {
    date: "2026-10-01",
    bounds: boundsForUserCount(0),
    cells: [{ x: 0, y: 0, char: "A", n: 3 }],
  };
  const withPost = buildDailySnapshot(initial,
    [{ userId: "local-preview-user", date: "2026-10-02",
      revision: 1, x: 20, y: 20, char: "星" }],
    { date: "2026-10-02", postStrength: 3 });
  assert.deepEqual(withPost.cells.find((c) => c.x === 20 && c.y === 20),
    { x: 20, y: 20, char: "星", n: 3 });
  assert.deepEqual(withPost.cells.find((c) => c.x === 21 && c.y === 20),
    { x: 21, y: 20, char: "星", n: 2 });
});


test("the map exposes three explicitly labeled, user-visible simulation models", async () => {
  const html = await readFile(join("site", "index.html"), "utf8");
  assert.match(html, /id="modelSelect"/);
  for(const name of ["legacy","bounded","playable"]) {
    assert.ok(html.includes('value="'+name+'"'), name);
  }
});
