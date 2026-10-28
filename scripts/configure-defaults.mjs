/** Local trusted operator only; not a public API endpoint. */
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { Store } from "../server/store.mjs";

const database = resolve(process.env.DB_PATH ?? "./.data/erosion.sqlite");
await mkdir(dirname(database), { recursive: true });
const mode = process.env.SAME_GLYPH_MODE ?? "sum";
const floor = Number(process.env.N1_OUTBOUND ?? 0);
const store = new Store(database);
try {
  store.setDefaultRules(mode, floor);
  console.log(JSON.stringify({ effectiveDefault: store.defaultRules() }));
} finally {
  store.close();
}
