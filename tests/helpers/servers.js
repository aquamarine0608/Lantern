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
const QWEN_PORT = 4174;

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

/* `errKey`, when given, adds a second knob: ?error=1|0 makes the server answer
   REACHABLE but broken (a 5xx), as opposed to ?offline=1's destroyed socket — the
   two are different failures and the service worker must handle both. */
function handleControl(state, key, req, res, errKey) {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/__control") return false;
  if (url.searchParams.has("offline")) state[key] = url.searchParams.get("offline") === "1";
  if (errKey && url.searchParams.has("error")) state[errKey] = url.searchParams.get("error") === "1";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(errKey ? { [key]: state[key], [errKey]: !!state[errKey] } : { [key]: state[key] }));
  return true;
}

function startAppServer(state) {
  const server = http.createServer((req, res) => {
    if (handleControl(state, "appOffline", req, res, "appError")) return;
    if (state.appOffline) {
      req.socket.destroy();
      return;
    }
    /* a redeploy / edge blip: the origin answers top-level navigations with a 503
       error page instead of the app. Only navigations — subresources keep working,
       which is exactly what makes the error document look "successful" to fetch(). */
    if (state.appError && req.headers["sec-fetch-mode"] === "navigate") {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><title>503</title><h1>origin temporarily unavailable</h1>");
      return;
    }
    const reqUrl = new URL(req.url, "http://x");
    let pathname = decodeURIComponent(reqUrl.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body = fs.readFileSync(file);
    /* /sw.js?v=<tag> serves a byte-different worker with that VERSION, so tests can
       exercise the real update/migration path without editing the file on disk */
    if (pathname === "/sw.js" && reqUrl.searchParams.has("v")) {
      const v = (reqUrl.searchParams.get("v") || "").replace(/[^a-zA-Z0-9]/g, "");
      body = Buffer.from(body.toString("utf8").replace(/const VERSION = "[^"]+";/, `const VERSION = "${v}";`));
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
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
  const fflateModule = fs.readFileSync(path.join(__dirname, "vendor", "fflate-browser.js"));
  const server = https.createServer({ key, cert }, (req, res) => {
    if (handleControl(state, "cdnOffline", req, res)) return;
    if (state.cdnOffline) {
      req.socket.destroy();
      return;
    }
    const host = (req.headers.host || "").split(":")[0];
    const pathname = new URL(req.url, "https://x").pathname;
    if (host === "cdn.jsdelivr.net" && (pathname.endsWith("/kokoro.web.js") || /\/fflate@[^/]+\/esm\/browser\.js$/.test(pathname))) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      res.end(pathname.endsWith("/kokoro.web.js") ? mockModule : fflateModule);
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

/* Mock of a user-run Qwen3-TTS server exposing the OpenAI-compatible
   /v1/audio/speech endpoint. Returns PCM16 WAV at 22.05 kHz (deliberately not
   the app's 24 kHz, to exercise the client-side resampler); duration is
   0.5 s / speed per request. Records request payloads for assertions. */
function startQwenServer(state) {
  state.qwenRequests = [];
  const server = http.createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization", // the app sends a Bearer key when configured
      "access-control-allow-methods": "POST, GET, OPTIONS",
    };
    if (req.url === "/__requests") {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify(state.qwenRequests));
      return;
    }
    const ctlUrl = new URL(req.url, "http://x");
    if (ctlUrl.pathname === "/__control") {
      if (ctlUrl.searchParams.has("offline")) state.qwenOffline = ctlUrl.searchParams.get("offline") === "1";
      if (ctlUrl.searchParams.has("hang")) state.qwenHang = ctlUrl.searchParams.get("hang") === "1";
      /* a STATUS CODE, not a boolean: the app's qwenErrorHtml distinguishes 401/403
         (bad key) and 404 (wrong path) from the generic "reported an error (n)".
         0 = off; the legacy `fail=1` call sites are normalised to 500 in net.js. */
      if (ctlUrl.searchParams.has("fail")) state.qwenFail = parseInt(ctlUrl.searchParams.get("fail"), 10) || 0;
      if (ctlUrl.searchParams.has("rate")) state.qwenRate = parseInt(ctlUrl.searchParams.get("rate"), 10) || 22050;
      if (ctlUrl.searchParams.has("delay")) state.qwenDelay = parseInt(ctlUrl.searchParams.get("delay"), 10) || 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ qwenOffline: state.qwenOffline, qwenHang: state.qwenHang, qwenFail: state.qwenFail, qwenRate: state.qwenRate }));
      return;
    }
    if (state.qwenOffline) {
      req.socket.destroy();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let payload = {};
        try { payload = JSON.parse(body); } catch {}
        payload.__auth = req.headers.authorization || null; /* recorded for assertions */
        state.qwenRequests.push(payload);
        if (state.qwenHang) return; /* accept the request, never answer — a black-holed server */
        if (state.qwenFail) {
          res.writeHead(state.qwenFail, { ...cors, "content-type": "application/json" });
          res.end(JSON.stringify({ error: "mock server failure" }));
          return;
        }
        const respond = () => {
        const rate = state.qwenRate || 22050;
        const n = Math.round((rate * 0.5) / (payload.speed || 1));
        const buf = Buffer.alloc(44 + n * 2);
        buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
        buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
        buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
        buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
        for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 260 * i) / rate) * 0.3 * 32767), 44 + i * 2);
        res.writeHead(200, { ...cors, "content-type": "audio/wav" });
        res.end(buf);
        };
        if (state.qwenDelay) setTimeout(respond, state.qwenDelay);
        else respond();
      });
      return;
    }
    res.writeHead(404, cors);
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(QWEN_PORT, "127.0.0.1", () => resolve(server));
  });
}

module.exports = { startAppServer, startCdnServer, startQwenServer, APP_PORT, CDN_PORT, QWEN_PORT };
