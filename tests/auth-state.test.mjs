import test from "node:test";
import assert from "node:assert/strict";
import { challengePurpose, requireChallengePurpose } from "../sites/auth-state.mjs";

test("registered challenge categories are distinct even when persisted SQL kind matches", () => {
  const reg = { kind: "register", userId: "user-1" };
  const login = { kind: "authenticate", userId: null };
  const deletion = { kind: "authenticate", userId: "user-1" };
  assert.equal(challengePurpose(reg), "register");
  assert.equal(challengePurpose(login), "login");
  assert.equal(challengePurpose(deletion), "delete");
  assert.equal(requireChallengePurpose(deletion, "delete"), deletion);
  assert.throws(() => requireChallengePurpose(login, "delete"), /wrong challenge kind/);
  assert.throws(() => requireChallengePurpose(deletion, "login"), /wrong challenge kind/);
  assert.throws(() => requireChallengePurpose(reg, "login"), /wrong challenge kind/);
  assert.throws(() => requireChallengePurpose(reg, "reset-password"), /unsupported/);
});

test("unbound and malformed persisted challenges fail closed", () => {
  for (const challenge of [
    null, {}, { kind: "authenticate" },
    { kind: "register", userId: null },
    { kind: "authenticate", userId: "" },
    { kind: "authenticate", userId: "../../admin" },
    { kind: "authenticate", userId: 1 },
    { kind: "magic", userId: "u" },
  ]) assert.throws(() => challengePurpose(challenge), /malformed/);
});
