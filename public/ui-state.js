/**
 * Pure UI lifecycle reducers. No DOM, network, timers or credentials.
 *
 * Authentication, asynchronous actions and verified archive selection were
 * previously encoded as interacting booleans. Represent them as legal states
 * so a stale async result cannot override an explicit user selection.
 */
const accountPhases = new Set(["checking", "unavailable", "anonymous", "authenticated", "busy"]);
const archivePhases = new Set(["loading", "ready", "empty", "error"]);
const accountOperations = new Set(["register", "login", "logout", "post", "delete"]);

function invalid(label) { throw new RangeError("invalid " + label + " state transition"); }
const freeze = value => Object.freeze(value);

export function initialAccountState() {
  return freeze({ phase: "checking", operation: null, previous: null });
}

/** A single inflight operation owns the account controls until synchronization. */
export function transitionAccount(state, event) {
  if (!accountPhases.has(state?.phase) || typeof event?.type !== "string") invalid("account");
  if (event.type === "SYNC" || event.type === "SETTLED") {
    if ((event.type === "SYNC" && state.phase === "busy") ||
        (event.type === "SETTLED" && state.phase !== "busy")) invalid("account");
    const phase = event.available === false ? "unavailable"
      : event.authenticated === true ? "authenticated" : "anonymous";
    return freeze({ phase, operation: null, previous: null });
  }
  if (event.type === "BEGIN") {
    if (!accountOperations.has(event.operation)) invalid("account");
    const allowed = state.phase === "anonymous"
      ? ["register", "login"]
      : state.phase === "authenticated"
      ? ["register", "logout", "post", "delete"]
      : [];
    if (!allowed.includes(event.operation)) invalid("account");
    return freeze({ phase: "busy", operation: event.operation, previous: state.phase });
  }
  if (event.type === "FAILED") {
    if (state.phase !== "busy" ||
        !["authenticated", "anonymous"].includes(state.previous)) invalid("account");
    return freeze({ phase: state.previous, operation: null, previous: null });
  }
  invalid("account");
}

export function initialArchiveState() {
  return freeze({ phase: "loading", view: "demo", userPreferredDemo: false, problem: null });
}

/**
 * The state of an API fetch (loading/ready/empty/error) and the currently
 * viewed data (demo/archive) are related but not interchangeable.
 */
export function transitionArchive(state, event) {
  if (!archivePhases.has(state?.phase) || typeof event?.type !== "string") invalid("archive");
  if (event.type === "SHOW_DEMO") {
    return freeze({ ...state, view: "demo", userPreferredDemo: true });
  }
  if (event.type === "SHOW_ARCHIVE") {
    if (state.phase !== "ready") invalid("archive");
    return freeze({ ...state, view: "archive", userPreferredDemo: false });
  }
  if (event.type === "LOAD") {
    if (state.phase !== "error" && state.phase !== "empty") invalid("archive");
    return freeze({ ...state, phase: "loading", problem: null, view: "demo" });
  }
  if (event.type === "READY") {
    if (state.phase !== "loading") invalid("archive");
    return freeze({ phase: "ready",
      view: state.userPreferredDemo ? "demo" : "archive",
      userPreferredDemo: state.userPreferredDemo, problem: null });
  }
  if (event.type === "EMPTY" || event.type === "ERROR") {
    if (state.phase !== "loading") invalid("archive");
    return freeze({ phase: event.type === "EMPTY" ? "empty" : "error",
      view: "demo", userPreferredDemo: state.userPreferredDemo,
      problem: event.type === "ERROR" ? (event.problem ?? "unavailable") : null });
  }
  invalid("archive");
}
