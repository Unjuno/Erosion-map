import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { Store } from "../server/store.mjs";

const location = resolve(process.env.DB_PATH ?? "./.data/erosion.sqlite");
await mkdir(dirname(location), { recursive: true });
const store = new Store(location);
try {
  const processed = store.publishClosedDays();
  console.log(JSON.stringify({ completed: processed.length, processed }));
} finally {
  store.close();
}
