const { startAppServer, startCdnServer, startQwenServer } = require("./servers");

module.exports = async () => {
  const state = { appOffline: false, cdnOffline: false, qwenOffline: false };
  const app = await startAppServer(state);
  const cdn = await startCdnServer(state);
  const qwen = await startQwenServer(state);
  globalThis.__LANTERN_SERVERS__ = { app, cdn, qwen, state };
};
