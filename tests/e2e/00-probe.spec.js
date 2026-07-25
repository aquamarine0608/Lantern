const { test, expect, startRead } = require("../helpers/fixtures");

test("environment probe: mock CDN, web audio clock, basic generation", async ({ page, mockTTS }) => {
  await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
  await page.goto("/#paste");
  await expect(page.locator(".wordmark")).toContainText("Lanter");

  // the mock module must have been served in place of the real CDN build
  const modText = await page.evaluate(async () => {
    const r = await fetch("https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js");
    return (await r.text()).slice(0, 40);
  });
  expect(modText).toContain("Mock of kokoro-js");

  // web audio clock must advance in headless
  const advanced = await page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const a = ctx.currentTime;
    await new Promise((r) => setTimeout(r, 400));
    const b = ctx.currentTime;
    await ctx.close();
    return b - a;
  });
  expect(advanced).toBeGreaterThan(0.2);

  // one full generation reaches the player
  await startRead(page);
  await expect(page.locator("#player")).toBeVisible();
  await expect(page.locator("#statusLine")).toContainText("tap the wave", { timeout: 30_000 });
});
