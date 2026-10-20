/**
 * Export PUBLIC daily snapshots only. No users, sessions, credential IDs or posts.
 * Can be uploaded as immutable static files to a CDN after the daily job runs.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertIsoDay } from "../dist/calendar.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.mjs";

export async function exportSnapshots(store, destination) {
  const folder = resolve(destination);
  const dataDir = join(folder, "data");
  await mkdir(dataDir, { recursive: true });
  const indexed = store.days(3650).reverse();
  if (indexed.length === 0) throw new Error("database has no published states");
  const history = [];
  let latest = null;
  for (const row of indexed) {
    assertIsoDay(row.day);
    const found = store.snapshot(row.day);
    if (!found) throw new Error("snapshot was removed during export");
    if (found.state.date !== row.day) {
      throw new Error("snapshot date disagrees with database key");
    }
    const serialized = JSON.stringify(found.state);
    const digest = createHash("sha256").update(serialized).digest("hex");
    if (digest !== found.sha256 || digest !== row.sha256) {
      throw new Error("snapshot integrity check failed for " + row.day);
    }
    // Do not add a newline: SHA-256 in the public index hashes exact file bytes.
    await writeFile(join(dataDir, "state-" + row.day + ".json"), serialized);
    history.push({ date: row.day, sha256: digest });
    latest = found.state;
  }
  await writeFile(join(dataDir, "index.json"), JSON.stringify(history) + "\n");
  await writeFile(join(folder, "data.js"),
    "export const state = " + JSON.stringify(latest) + ";\n" +
    "export const historyIndex = " + JSON.stringify(history) + ";\n");
  return { days: history.length, latestDay: latest.date, destination: folder };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databaseFile = resolve(process.env.DB_PATH ?? "./.data/erosion.sqlite");
  const destination = resolve(process.env.OUTPUT_DIR ?? "./site");
  await mkdir(dirname(databaseFile), { recursive: true });
  const store = new Store(databaseFile);
  try {
    console.log(JSON.stringify(await exportSnapshots(store, destination)));
  } finally {
    store.close();
  }
}
