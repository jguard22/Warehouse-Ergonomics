// Tiny static file server for the demo (no dependencies).
//   node scripts/serve.mjs            -> http://127.0.0.1:5871/
//   PORT=8080 node scripts/serve.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".csv": "text/csv",
  ".glb": "model/gltf-binary", ".mp4": "video/mp4" };

export function startServer(port = Number(process.env.PORT || 5871), root = ROOT) {
  const server = http.createServer(async (req, res) => {
    try {
      let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end("forbidden"); return; }
      const body = await readFile(file);
      const type = TYPES[path.extname(file)] || "application/octet-stream";
      // byte ranges, like GitHub Pages: a <video> can seek (poster frames, scrubbing) only when the server honours them
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        if (start > end || start >= body.length) { res.writeHead(416, { "content-range": `bytes */${body.length}` }).end(); return; }
        res.writeHead(206, { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 }).end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes" }).end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5871);
  await startServer(port);
  console.log(`http://127.0.0.1:${port}/`);
}
