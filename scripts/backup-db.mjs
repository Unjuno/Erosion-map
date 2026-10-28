/** Trusted CLI only: online SQLite backup plus an integrity check. Never serve it. */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../server/store.mjs";

const source = resolve(process.env.DB_PATH ?? "./.data/erosion.sqlite");
const folder = resolve(process.env.BACKUP_DIR ?? "./.data/backups");
await mkdir(dirname(source), { recursive: true });
await mkdir(folder, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(folder,
  "erosion-" + timestamp + "-" + randomBytes(5).toString("hex") + ".sqlite");
const store = new Store(source);
try {
  store.backupTo(destination);
} finally {
  store.close();
}
const check = new Store(destination);
try {
  const row = check.db.prepare("PRAGMA integrity_check").get();
  if (row?.integrity_check !== "ok") {
    throw new Error("backup failed SQLite integrity_check");
  }
  check.latestState(); // Verify the most recent published state's SHA-256.
  console.log(JSON.stringify({
    status: "verified", destination, latestDay: check.latestState()?.date ?? null,
  }));
} finally {
  check.close();
}
