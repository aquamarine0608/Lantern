const { test, expect, startRead, waitForFileMode } = require("../helpers/fixtures");
const { importEpub } = require("../helpers/epub");
const { setQwenOffline, setQwenHang, getQwenRequests } = require("../helpers/net");

const QWEN_URL = "http://127.0.0.1:4174";

/* Switch the app to the Qwen3-TTS server engine through the real settings UI. */
async function enableQwen(page, url = QWEN_URL) {
  await page.click("#libVoiceBtn");
  await page.click('#engineBtns button[data-e="qwen"]');
  await page.fill("#qwenUrl", url);
  await page.locator("#qwenUrl").blur();
  await page.click("#sheetBackdrop");
}

const speakingSi = async (page) => {
  const el = page.locator(".sent.speaking");
  return (await el.count()) ? Number(await el.first().getAttribute("data-si")) : -1;
};

test.describe("Qwen3-TTS server engine", () => {
  test.afterEach(async () => {
    await setQwenOffline(false);
    await setQwenHang(false);
  });

  test("Stop cancels instantly even when the server hangs mid-request", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await setQwenHang(true);

    await page.click("#pasteModeBtn");
    await startRead(page);
    await expect(page.locator("#readBtn")).toHaveText("Stop reading");
    await page.waitForTimeout(800); // the request is now parked on a server that will never answer
    await page.click("#readBtn"); // Stop must abort the in-flight fetch, not wait 30 s for it
    await expect(page.locator("#readBtn")).toHaveText("Read aloud", { timeout: 5000 });
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#banner")).toBeHidden(); // an intentional stop is not an error
  });

  test("jumping in the reader is never blocked by a hung request", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await importEpub(page);
    await page.click(".book");
    await setQwenHang(true);
    await page.click("#rPlay"); // this pump parks on a request that will never answer
    await page.waitForTimeout(800);
    await setQwenHang(false);
    await page.click('.sent[data-si="2"]'); // must abort the hung pump and start fresh
    await expect.poll(() => speakingSi(page), { timeout: 10_000 }).toBe(2);
  });

  test("pasted text reads through the server — no on-device model involved", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    const before = (await getQwenRequests()).length;
    await enableQwen(page);
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · server voice");

    await page.click("#pasteModeBtn");
    await startRead(page); // three sentences
    await waitForFileMode(page);

    // three requests hit the server with the right payload
    const reqs = (await getQwenRequests()).slice(before);
    expect(reqs.length).toBe(3);
    expect(reqs[0].model).toBe("qwen3-tts");
    expect(reqs[0].voice).toBe("cherry");
    expect(reqs[0].input).toContain("The lantern glows");

    // 3 × 0.5 s of server audio, resampled 22.05 kHz → 24 kHz
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 1.5)).toBeLessThan(0.15);

    // the 90 MB on-device model must never have been touched
    expect(await page.evaluate(() => window.__TTS_LOADS || 0)).toBe(0);
    await expect(page.locator("#banner")).toBeHidden();
  });

  test("books read through the server with the same moving highlight", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await importEpub(page);
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.locator("#rStatus")).toContainText(/Chapter 1 of 3/);
    expect(await page.evaluate(() => window.__TTS_LOADS || 0)).toBe(0);
  });

  test("the speed setting is passed to the server and honored", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    const before = (await getQwenRequests()).length;
    await page.click("#pasteModeBtn");
    await page.click('#speeds button[data-s="1.5"]');
    await startRead(page, "One quick sentence. Then another one.");
    await waitForFileMode(page);
    const reqs = (await getQwenRequests()).slice(before);
    expect(reqs.every((r) => r.speed === 1.5)).toBe(true);
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 2 * (0.5 / 1.5))).toBeLessThan(0.12);
  });

  test("an unreachable server fails gracefully and recovery works", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await setQwenOffline(true);

    await page.click("#pasteModeBtn");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("Something went wrong", { timeout: 15_000 });
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();

    await setQwenOffline(false);
    await page.click("#readBtn");
    await waitForFileMode(page);
  });

  test("engine choice, server address and voice persist across a reload", async ({ page }) => {
    await page.goto("/");
    await enableQwen(page);
    await page.click("#libVoiceBtn");
    await page.fill("#qwenVoice", "ethan");
    await page.locator("#qwenVoice").blur();
    await page.click("#sheetBackdrop");

    await page.reload();
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · server voice");
    await page.click("#libVoiceBtn");
    await expect(page.locator('#engineBtns button[data-e="qwen"]')).toHaveClass(/on/);
    await expect(page.locator("#qwenUrl")).toHaveValue(QWEN_URL);
    await expect(page.locator("#qwenVoice")).toHaveValue("ethan");
  });

  test("switching back to the on-device engine restores Kokoro reading", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);

    await page.click("#pasteBackBtn"); // the engine picker lives in the library / reader sheets
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="kokoro"]');
    await page.click("#sheetBackdrop");
    await expect(page.locator("#modelStateText")).toHaveText("voice model not loaded");

    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    await expect(page.locator("#modelStateText")).toHaveText("voice model ready");
    expect(await page.evaluate(() => window.__TTS_LOADS)).toBe(1);
  });

  test("switching to an unconfigured server mid-book parks cleanly with no stale status", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 1.5 });
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);

    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]'); // no server URL entered
    await page.click("#sheetBackdrop");

    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await expect(page.locator("#rIconPlay")).toBeVisible();
    await expect(page.locator("#rStatus")).not.toContainText("generating on-device");
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");

    // configuring the server and tapping play recovers in place
    await page.click("#fontBtn");
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    await page.click("#sheetBackdrop");
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
  });

  test("without a server address, reading explains what to do instead of hanging", async ({ page }) => {
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    await page.click("#sheetBackdrop"); // no URL entered
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · set server address");

    await page.click("#pasteModeBtn");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();
  });
});
