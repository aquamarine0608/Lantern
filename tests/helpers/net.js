const http = require("http");
const https = require("https");
const { APP_PORT, CDN_PORT } = require("./servers");

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

module.exports = { setAppOffline, setCdnOffline };
