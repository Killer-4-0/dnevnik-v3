const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json"
};

// Локальный сервер приложения: `node server.js` → http://localhost:8787,
// с телефона в той же Wi-Fi сети — http://IP-компьютера:8787
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const pathname = (req.url || "").split("?")[0];

  if (req.method === "GET" && pathname === "/api/health") {
    res.writeHead(200, {"Content-Type": "application/json"});
    return res.end(JSON.stringify({ok: true}));
  }

  if (req.method === "GET") {
    let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {"Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream"});
      return fs.createReadStream(file).pipe(res);
    }
  }

  res.writeHead(404, {"Content-Type": "application/json"});
  res.end(JSON.stringify({error: "Not found"}));
});

server.listen(PORT, "0.0.0.0", () => console.log("Дневник на порту " + PORT));
