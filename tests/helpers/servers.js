/* Local servers for the e2e suite.
   - App server (http://127.0.0.1:4173): serves the repo root (the real app).
   - Mock CDN server (https on :443): impersonates cdn.jsdelivr.net (serves the
     mock kokoro module) and fonts.googleapis.com (serves empty CSS). The
     browser is pointed here via --host-resolver-rules.
   Both servers expose GET /__control?offline=1|0 which, when offline, destroys
   every other incoming socket — a faithful "network unplugged" for both page
   and service-worker fetches. */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_PORT = 4173;
const CDN_PORT = 443;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
};

function handleControl(state, key, req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/__control") return false;
  if (url.searchParams.has("offline")) state[key] = url.searchParams.get("offline") === "1";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ [key]: state[key] }));
  return true;
}

function startAppServer(state) {
  const server = http.createServer((req, res) => {
    if (handleControl(state, "appOffline", req, res)) return;
    if (state.appOffline) {
      req.socket.destroy();
      return;
    }
    let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(APP_PORT, "127.0.0.1", () => resolve(server));
  });
}

function ensureCert() {
  const dir = path.join(__dirname, "..", ".certs");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 365 ` +
        `-subj "/CN=cdn.jsdelivr.net" ` +
        `-addext "subjectAltName=DNS:cdn.jsdelivr.net,DNS:fonts.googleapis.com,DNS:fonts.gstatic.com,DNS:huggingface.co,DNS:*.huggingface.co"`,
      { stdio: "pipe" }
    );
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function startCdnServer(state) {
  const { key, cert } = ensureCert();
  const mockModule = fs.readFileSync(path.join(__dirname, "mock-kokoro.web.js"));
  const server = https.createServer({ key, cert }, (req, res) => {
    if (handleControl(state, "cdnOffline", req, res)) return;
    if (state.cdnOffline) {
      req.socket.destroy();
      return;
    }
    const host = (req.headers.host || "").split(":")[0];
    const pathname = new URL(req.url, "https://x").pathname;
    if (host === "cdn.jsdelivr.net" && pathname.endsWith("/kokoro.web.js")) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(mockModule);
      return;
    }
    if (host === "fonts.googleapis.com") {
      res.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end("/* mock google fonts css */");
      return;
    }
    res.writeHead(404, { "access-control-allow-origin": "*" });
    res.end("mock cdn: not found");
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(CDN_PORT, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startAppServer, startCdnServer, APP_PORT, CDN_PORT };
