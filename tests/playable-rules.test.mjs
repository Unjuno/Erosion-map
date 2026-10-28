import test from "node:test";
import assert from "node:assert/strict";
import { advanceOneDay, boundsForUserCount, resolveCollision } from "../dist/engine.js";
import { buildDailySnapshot } from "../dist/daily.js";
import { nextIsoDay } from "../dist/calendar.js";
import { Store } from "../server/store.mjs";

const playable = { sameGlyphMode: "max", minimumOutgoingInfluence: 1 };
const initial = {
  date: "2026-10-20",
  bounds: boundsForUserCount(0),
  cells: [{ x: 0, y: 0, char: "A", n: 1 }],
};

test("legacy rules preserve N1 non-propagation; experimental max+floor1 spreads", () => {
  const normal = advanceOneDay(initial, "2026-10-21");
  assert.equal(normal.cells.length, 1);
  const suggested = advanceOneDay(initial, "2026-10-21", playable);
  assert.equal(suggested.cells.length, 5);
  for (const [x,y] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    assert.deepEqual(suggested.cells.find(c=>c.x===x&&c.y===y),
      { x, y, char: "A", n: 1 });
  }
});

test("new N1 posts can propagate under explicitly selected experimental mode", () => {
  const empty = { ...initial, cells: [] };
  const post = { userId: "example",date:"2026-10-21",revision:1,x:0,y:0,char:"文" };
  const updated = buildDailySnapshot(empty,[post],{date:"2026-10-21",...playable});
  assert.equal(updated.cells.length,5);
  assert.deepEqual(updated.cells.find(c=>c.x===1&&c.y===0),
    { x:1,y:0,char:"文",n:1 });
});

test("playable mode never increases stored N without new posts", () => {
  let world = {
    date: "2026-01-01", bounds: boundsForUserCount(0),
    cells: [{ x:0,y:0,char:"海",n:3 },{x:10,y:2,char:"森",n:2}],
  };
  for(let i=0;i<25;i++){
    const before = Math.max(...world.cells.map(c=>c.n));
    world=advanceOneDay(world,nextIsoDay(world.date),playable);
    assert.ok(world.cells.every(c=>c.n<=before));
    assert.ok(world.cells.length<=250000);
  }
});

test("the unsafe combination sum+N1 propagation is refused", () => {
  assert.throws(() => advanceOneDay(initial,"2026-10-21",{
    sameGlyphMode:"sum",minimumOutgoingInfluence:1,
  }),/requires max grouping/);
});

test("SQLite keeps experimental daily rules isolated from normal default", () => {
  const db=new Store();
  try {
    db.initialize(new Date("2026-10-20T12:00:00Z"));
    assert.deepEqual(db.dayRules("2026-10-20"),
      {postStrength:1,sameGlyphMode:"sum",minimumOutgoingInfluence:0});
    db.createUser("test-user");
    db.setDayRules("2026-10-20","max",1);
    db.submit("test-user","2026-10-20",0,0,"文");
    const published=db.publishDay("2026-10-20");
    assert.equal(published.state.cells.length,5);
    assert.deepEqual(db.dayRules("2026-10-20"),
      {postStrength:1,sameGlyphMode:"max",minimumOutgoingInfluence:1});
    assert.throws(()=>db.setDayRules("2026-10-20","sum"),/immutable/);
    assert.deepEqual(db.dayRules("2026-10-21"),
      {postStrength:1,sameGlyphMode:"sum",minimumOutgoingInfluence:0});
  }finally{db.close();}
});
