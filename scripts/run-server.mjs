import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Store } from "../server/store.mjs";
import { createApplication } from "../server/http.mjs";

const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:4173";
const rpID = process.env.RP_ID ?? "localhost";
const port = Number(process.env.PORT ?? 4173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new RangeError("PORT must be between 1 and 65535");
}
const dbPath = resolve(process.env.DB_PATH ?? "./.data/erosion.sqlite");
await mkdir(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
store.initialize();
store.pruneExpirations();

// Single-process development scheduler. The production platform should use a
// durable scheduled job and a multi-instance-safe database transaction instead.
function tickClosedDays() {
  try {
    const published = store.publishClosedDays();
    if (published.length > 0) console.log("Published closed days:", published);
  } catch (error) {
    console.error("Daily state publication failed:", error);
  }
}
tickClosedDays();
const dailyTimer = setInterval(tickClosedDays, 60 * 60_000);


const server = createApplication({ store, origin, rpID });
server.listen(port, "127.0.0.1", () => {
  console.log("Local WebAuthn dev server: " + origin);
  console.log("Running with experimental node:sqlite, not production hosting.");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(dailyTimer);
    server.close(() => { store.close(); process.exit(0); });
  });
}
