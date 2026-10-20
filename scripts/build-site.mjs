import { cp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, "site");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js", "account.html", "account.css", "account.js", "demo-data.js", "ranking.html", "ranking.css", "ranking.js", "policy.html", "policy.css"]) {
  await cp(join(root, "public", file), join(target, file));
}
for (const file of ["engine.js", "daily.js", "calendar.js"]) {
  await cp(join(root, "dist", file), join(target, file));
}
console.log("Static preview assembled in site/");
