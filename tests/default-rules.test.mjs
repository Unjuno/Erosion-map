import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";

test("default profile applies to future days, and each publication freezes it", () => {
  const db = new Store();
  try {
    db.initialize(new Date("2026-10-20T12:00:00Z"));
    assert.deepEqual(db.defaultRules(), {
      sameGlyphMode:"sum",minimumOutgoingInfluence:0,
    });
    db.setDefaultRules("max",1);
    db.createUser("account");
    db.submit("account","2026-10-20",0,0,"光");
    assert.deepEqual(db.dayRules("2026-10-20"), {
      postStrength:1,sameGlyphMode:"max",minimumOutgoingInfluence:1,
    });
    const day1=db.publishDay("2026-10-20");
    assert.equal(day1.state.cells.length,5);

    db.setDefaultRules("sum",0);
    assert.deepEqual(db.dayRules("2026-10-20"), {
      postStrength:1,sameGlyphMode:"max",minimumOutgoingInfluence:1,
    });
    assert.deepEqual(db.dayRules("2026-10-21"), {
      postStrength:1,sameGlyphMode:"sum",minimumOutgoingInfluence:0,
    });

    db.setDayRules("2026-10-21","max",0);
    assert.deepEqual(db.dayRules("2026-10-21"), {
      postStrength:1,sameGlyphMode:"max",minimumOutgoingInfluence:0,
    });
    db.setPostStrength("2026-10-22",3);
    assert.deepEqual(db.dayRules("2026-10-22"), {
      postStrength:3,sameGlyphMode:"sum",minimumOutgoingInfluence:0,
    });
  } finally { db.close(); }
});

test("unsafe default pair is refused without touching settings", () => {
  const db = new Store();
  try {
    assert.throws(()=>db.setDefaultRules("sum",1),/invalid default/);
    assert.deepEqual(db.defaultRules(), {
      sameGlyphMode:"sum",minimumOutgoingInfluence:0,
    });
  } finally { db.close(); }
});
