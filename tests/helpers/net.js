const http = require("http");
const https = require("https");
const { APP_PORT, CDN_PORT, QWEN_PORT } = require("./servers");

function controlRequest(useTls, port, hostHeader, query) {
  const mod = useTls ? https : http;
  const opts = {
    host: "127.0.0.1",
    port,
    path: `/__control?${query}`,
    headers: { host: hostHeader },
    rejectUnauthorized: false,
  };
  return new Promise((resolve, reject) => {
    const req = mod.get(opts, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
  });
}

const setAppOffline = (offline) => controlRequest(false, APP_PORT, "127.0.0.1", `offline=${offline ? 1 : 0}`);
const setCdnOffline = (offline) => controlRequest(true, CDN_PORT, "cdn.jsdelivr.net", `offline=${offline ? 1 : 0}`);
const setQwenOffline = (offline) => controlRequest(false, QWEN_PORT, "127.0.0.1", `offline=${offline ? 1 : 0}`);
/* reachable-but-broken origin: navigations get a 503 error PAGE, not a dead socket */
const setAppError = (error) => controlRequest(false, APP_PORT, "127.0.0.1", `error=${error ? 1 : 0}`);

function qwenControl(query) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: QWEN_PORT, path: `/__control?${query}` }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
}
const setQwenHang = (hang) => qwenControl(`hang=${hang ? 1 : 0}`);
/* accepts true (legacy = 500), false (off), or an explicit status code (401/403/404/…) */
const setQwenFail = (fail) => qwenControl(`fail=${fail === true ? 500 : Number(fail) || 0}`);
const setQwenRate = (rate) => qwenControl(`rate=${rate}`);
const setQwenDelay = (ms) => qwenControl(`delay=${ms}`);

function getQwenRequests() {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: QWEN_PORT, path: "/__requests" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

module.exports = { setAppOffline, setAppError, setCdnOffline, setQwenOffline, setQwenHang, setQwenFail, setQwenRate, setQwenDelay, getQwenRequests };
