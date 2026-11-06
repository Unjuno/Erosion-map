import test from "node:test";
import assert from "node:assert/strict";
import { classifyDay, transitionDay } from "../sites/day-state.mjs";

test("durable day phase is derived from authoritative closure and snapshot flags", () => {
  assert.equal(classifyDay(), "open");
  assert.equal(classifyDay({ sealed: true }), "sealed");
  assert.equal(classifyDay({ published: true }), "published");
  assert.equal(classifyDay({ sealed: true, published: true }), "published",
    "committed immutable snapshot has precedence");
  assert.throws(() => classifyDay({ published: 1 }), TypeError);
});

test("post revision, sealing, final publication and replay form a legal monotone lifecycle", () => {
  let phase = classifyDay();
  for (let n = 0; n < 4; n++) {
    phase = transitionDay(phase, "SUBMIT");
    assert.equal(phase, "open");
  }
  phase = transitionDay(phase, "SEAL");
  assert.equal(phase, "sealed");
  assert.equal(transitionDay(phase, "SEAL"), "sealed", "closure retry is idempotent");
  assert.throws(() => transitionDay(phase, "SUBMIT"), /already published or sealed/);
  phase = transitionDay(phase, "FINALIZE");
  assert.equal(phase, "published");
  assert.equal(transitionDay(phase, "FINALIZE"), "published",
    "publication retry returns the same immutable state");
  assert.throws(() => transitionDay(phase, "SUBMIT"), /already published or sealed/);
  assert.throws(() => transitionDay(phase, "SEAL"), /invalid day lifecycle/);
  assert.equal(transitionDay(phase, "READ"), "published");
});

test("a day cannot finalize without durable closure and cannot be reset", () => {
  assert.throws(() => transitionDay("open", "FINALIZE"), /invalid day lifecycle/);
  assert.throws(() => transitionDay("published", "REOPEN"), /unknown day lifecycle/);
  assert.throws(() => transitionDay("unknown", "SUBMIT"), /unknown day lifecycle/);
});
