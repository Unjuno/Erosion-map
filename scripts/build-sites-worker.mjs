import { build } from "esbuild";
import { resolve } from "node:path";

// The bundle is a Web-standard fetch/scheduled Worker with D1 and assets
// bindings. Node-only modules are external: Sites/Workers runtime must enable
// node compatibility for its chosen compatibility date.
const destination = resolve("site/_worker.js");
await build({
  entryPoints: [resolve("sites/worker.mjs")],
  outfile: destination,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*"],
  legalComments: "none",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});
console.log("Sites worker emitted at site/_worker.js");
