import test from "node:test";
import assert from "node:assert/strict";
import { assertIsoDay, nextIsoDay, dayAtInstant } from "../dist/calendar.js";

test("dates are valid real ISO days (including leap years)", () => {
  assert.doesNotThrow(() => assertIsoDay("2028-02-29"));
  for (const value of ["2026-02-29", "2026-13-01", "2026-00-01", "2026-04-31", "bad"]) {
    assert.throws(() => assertIsoDay(value), RangeError);
  }
});

test("next day handles month and leap-year boundaries", () => {
  assert.equal(nextIsoDay("2028-02-28"), "2028-02-29");
  assert.equal(nextIsoDay("2028-02-29"), "2028-03-01");
  assert.equal(nextIsoDay("2026-12-31"), "2027-01-01");
});

test("the official site day is Asia/Tokyo, not implicit server time", () => {
  assert.equal(dayAtInstant(new Date("2026-10-20T14:59:59Z")), "2026-10-20");
  assert.equal(dayAtInstant(new Date("2026-10-20T15:00:00Z")), "2026-10-21");
});
