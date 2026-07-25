module.exports = async () => {
  const s = globalThis.__LANTERN_SERVERS__;
  if (!s) return;
  await Promise.all([
    new Promise((r) => s.app.close(r)),
    new Promise((r) => s.cdn.close(r)),
    new Promise((r) => s.qwen.close(r)),
  ]);
};
