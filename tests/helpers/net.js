const http = require("http");
const https = require("https");
const { APP_PORT, CDN_PORT, QWEN_PORT } = require("./servers");

function controlRequest(useTls, port, hostHeader, offline) {
  const mod = useTls ? https : http;
  const opts = {
    host: "127.0.0.1",
    port,
    path: `/__control?offline=${offline ? 1 : 0}`,
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

const setAppOffline = (offline) => controlRequest(false, APP_PORT, "127.0.0.1", offline);
const setCdnOffline = (offline) => controlRequest(true, CDN_PORT, "cdn.jsdelivr.net", offline);
const setQwenOffline = (offline) => controlRequest(false, QWEN_PORT, "127.0.0.1", offline);

function setQwenHang(hang) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: QWEN_PORT, path: `/__control?hang=${hang ? 1 : 0}` }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
}

function getQwenRequests() {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: QWEN_PORT, path: "/__requests" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}

module.exports = { setAppOffline, setCdnOffline, setQwenOffline, setQwenHang, getQwenRequests };
