const { startAppServer, startCdnServer } = require("./servers");

module.exports = async () => {
  const state = { appOffline: false, cdnOffline: false };
  const app = await startAppServer(state);
  const cdn = await startCdnServer(state);
  globalThis.__LANTERN_SERVERS__ = { app, cdn, state };
};
