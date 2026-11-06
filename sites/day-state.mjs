/**
 * The durable day lifecycle is derived from D1 rows, not a worker-local flag.
 * A day can accept revisions only before sealing; once sealed, the anonymous
 * final submissions are immutable; publication is idempotent.
 *
 * The global baseline/uninitialized state is separate: one baseline snapshot
 * must exist before normal requests accept new posts. A recovery routine may
 * process legacy data predating that baseline.
 */
const phases = new Set(["open", "sealed", "published"]);
const transitions = Object.freeze({
  SUBMIT: Object.freeze({ open: "open" }),
  SEAL: Object.freeze({ open: "sealed", sealed: "sealed" }),
  FINALIZE: Object.freeze({ sealed: "published", published: "published" }),
  READ: Object.freeze({ open: "open", sealed: "sealed", published: "published" }),
});

/** A committed snapshot dominates the corresponding closure. */
export function classifyDay({ sealed = false, published = false } = {}) {
  if (typeof sealed !== "boolean" || typeof published !== "boolean") {
    throw new TypeError("durable day flags must be booleans");
  }
  return published ? "published" : sealed ? "sealed" : "open";
}

/** Invalid transitions fail closed; final state cannot be reopened. */
export function transitionDay(phase, event) {
  if (!phases.has(phase) || !Object.hasOwn(transitions, event)) {
    throw new RangeError("unknown day lifecycle transition");
  }
  const next = transitions[event][phase];
  if (!next) {
    if (event === "SUBMIT") throw new Error("day already published or sealed");
    throw new Error("invalid day lifecycle transition: " + phase + " -> " + event);
  }
  return next;
}
