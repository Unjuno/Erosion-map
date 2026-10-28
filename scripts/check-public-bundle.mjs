import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve("site");
const forbidden = [
  /(^|\/)\.env(?:$|\/|\.)/i,
  /(^|\/)\.git(?:$|\/)/i,
  /(^|\/)HANDOFF\.md$/i,
  /\.(?:sqlite|db|pem|key|p12|pfx|bak)$/i,
  /\.sqlite-(?:wal|shm)$/i,
];
const files = [];
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const absolute = join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("public bundle contains a symbolic link");
    }
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
    else throw new Error("unexpected public asset type");
  }
}
await walk(root);
const blocked = files.filter((path) => forbidden.some((pattern) => pattern.test(path)));
if (blocked.length > 0) throw new Error("unsafe files in public bundle: " + blocked.join(", "));
for (const mandatory of ["index.html", "account.html", "ranking.html",
  "policy.html", "_worker.js", "engine.js", "daily.js"]) {
  if (!files.includes(mandatory)) throw new Error("missing public asset: " + mandatory);
}
const worker = await stat(join(root, "_worker.js"));
if (worker.size < 30_000) throw new Error("Sites worker build is unexpectedly small");
console.log(JSON.stringify({ clean: true, files: files.length, workerBytes: worker.size }));
