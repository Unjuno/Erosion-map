import test from "node:test";
import assert from "node:assert/strict";
import {
  initialAccountState, transitionAccount,
  initialArchiveState, transitionArchive,
} from "../public/ui-state.js";

test("account state machine forbids interleaving passkey and deletion operations", () => {
  let state = initialAccountState();
  assert.equal(state.phase, "checking");
  assert.throws(() => transitionAccount(state, {
    type: "BEGIN", operation: "register",
  }), /invalid account/);
  state = transitionAccount(state, { type: "SYNC", available: true, authenticated: false });
  assert.equal(state.phase, "anonymous");
  state = transitionAccount(state, { type: "BEGIN", operation: "register" });
  assert.deepEqual({ phase: state.phase, operation: state.operation },
    { phase: "busy", operation: "register" });
  assert.throws(() => transitionAccount(state, {
    type: "BEGIN", operation: "login",
  }), /invalid account/);
  assert.throws(() => transitionAccount(state, {
    type: "SYNC", available: false,
  }), /invalid account/);
  state = transitionAccount(state, { type: "SETTLED", available: true, authenticated: true });
  assert.equal(state.phase, "authenticated");
  state = transitionAccount(state, { type: "BEGIN", operation: "delete" });
  state = transitionAccount(state, { type: "FAILED" });
  assert.equal(state.phase, "authenticated", "cancelled deletion must leave current login");
  state = transitionAccount(state, { type: "BEGIN", operation: "post" });
  state = transitionAccount(state, { type: "SETTLED", available: false });
  assert.equal(state.phase, "unavailable", "backend outage never masquerades as logged in");
  assert.throws(() => transitionAccount(state, {
    type: "BEGIN", operation: "post",
  }), /invalid account/);
});

test("archive state machine respects user demo choice during late asynchronous loading", () => {
  let state = initialArchiveState();
  state = transitionArchive(state, { type: "SHOW_DEMO" });
  state = transitionArchive(state, { type: "READY" });
  assert.deepEqual({ phase: state.phase, view: state.view },
    { phase: "ready", view: "demo" });
  state = transitionArchive(state, { type: "SHOW_ARCHIVE" });
  assert.equal(state.view, "archive");
  state = transitionArchive(state, { type: "SHOW_DEMO" });
  assert.equal(state.view, "demo");
  assert.throws(() => transitionArchive(state, { type: "READY" }), /invalid archive/);
});

test("integrity failures and empty archives are distinct terminal states until retry", () => {
  let state = initialArchiveState();
  state = transitionArchive(state, { type: "ERROR", problem: "integrity" });
  assert.deepEqual({ phase: state.phase, view: state.view, problem: state.problem },
    { phase: "error", view: "demo", problem: "integrity" });
  assert.throws(() => transitionArchive(state, {
    type: "SHOW_ARCHIVE",
  }), /invalid archive/);
  state = transitionArchive(state, { type: "LOAD" });
  assert.equal(state.phase, "loading");
  state = transitionArchive(state, { type: "EMPTY" });
  assert.equal(state.phase, "empty");
  assert.equal(state.view, "demo");
  assert.equal(state.problem, null);
});

test("state reducers cannot be bypassed with unknown phases or events", () => {
  assert.throws(() => transitionAccount({ phase: "admin" }, { type: "SYNC" }),
    /invalid account/);
  assert.throws(() => transitionArchive({ phase: "published" }, { type: "READY" }),
    /invalid archive/);
  assert.throws(() => transitionAccount(initialAccountState(), { type: "UNLOCK" }),
    /invalid account/);
});
