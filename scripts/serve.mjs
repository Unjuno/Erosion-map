import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, sep, extname } from "node:path";

const root = resolve(import.meta.dirname, "../site");
const port = Number(process.env.PORT ?? 4173);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new RangeError("PORT must be an integer from 1 to 65535");
}
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = decodeURIComponent(path) === "/"
      ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Length": String(content.byteLength),
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log("Erosion Map preview: http://127.0.0.1:" + port);
});
