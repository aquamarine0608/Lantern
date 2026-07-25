const { test, expect, startRead, waitForFileMode } = require("../helpers/fixtures");

const LONG_TEXT =
  "Sentence number one is here. Sentence number two is here. Sentence number three is here. " +
  "Sentence number four is here. Sentence number five is here. Sentence number six is here. " +
  "Sentence number seven is here. Sentence number eight is here.";

test.describe("stopping and error paths", () => {
  test("stop mid-generation keeps the partial audio as a seekable file", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 400, chunkSeconds: 0.6 });
    await page.goto("/#paste");
    await startRead(page, LONG_TEXT);
    await expect(page.locator("#statusLine")).toContainText(/sentence [2-9]/, { timeout: 20_000 });
    await page.click("#readBtn"); // acts as Stop
    await waitForFileMode(page, 20_000);
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#saveBtn")).toBeEnabled();
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(duration).toBeGreaterThan(0.5);
    expect(duration).toBeLessThan(8 * 0.6); // strictly partial
  });

  test("stop before any audio returns cleanly to idle", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 5000, chunkSeconds: 0.5 });
    await page.goto("/#paste");
    await startRead(page);
    await expect(page.locator("#readBtn")).toHaveText("Stop reading");
    await page.click("#readBtn");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud", { timeout: 15_000 });
    await expect(page.locator("#player")).toBeHidden();
  });

  test("model download failure shows the error, cleans up audio contexts, and retry works", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 100, loadFail: true, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await startRead(page);
    await expect(page.locator("#banner")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#bannerText")).toContainText("Couldn't fetch the voice model");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#modelStateText")).toHaveText("voice model not loaded");

    // no leaked AudioContexts: iOS caps live contexts, so a failed attempt must close its context
    const leaked = await page.evaluate(() => window.__CTXS.filter((c) => c.state !== "closed").length);
    expect(leaked).toBe(0);

    // recover and read successfully
    await page.evaluate(() => (window.__TTS_MOCK__.loadFail = false));
    await page.click("#readBtn");
    await waitForFileMode(page);
    await expect(page.locator("#modelStateText")).toHaveText("voice model ready");
  });

  test("synthesis failure mid-stream keeps the partial audio and shows the error", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 100, chunkSeconds: 0.5, streamFailAfter: 2 });
    await page.goto("/#paste");
    await startRead(page, LONG_TEXT);
    await expect(page.locator("#bannerText")).toContainText("Something went wrong", { timeout: 15_000 });
    await waitForFileMode(page, 20_000);
    await expect(page.locator("#saveBtn")).toBeEnabled();
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 1.0)).toBeLessThan(0.1); // exactly the two synthesized sentences
  });

  test("synthesis failure before any audio returns to idle — no phantom empty player", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 100, chunkSeconds: 0.5, streamFailAfter: 0 });
    await page.goto("/#paste");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("Something went wrong", { timeout: 15_000 });
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#saveBtn")).toBeDisabled();

    // and the app recovers on the next attempt
    await page.evaluate(() => (window.__TTS_MOCK__.streamFailAfter = -1));
    await page.click("#readBtn");
    await waitForFileMode(page);
  });

  test("a reading where every chunk is empty returns to idle instead of an empty player", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0 });
    await page.goto("/#paste");
    await startRead(page, "One. Two.");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud", { timeout: 15_000 });
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#saveBtn")).toBeDisabled();
  });

  test("an empty audio chunk from the engine is skipped without an error", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5, emptyChunkAt: 1 });
    await page.goto("/#paste");
    await startRead(page);
    await waitForFileMode(page);
    await expect(page.locator("#banner")).toBeHidden(); // no error surfaced
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 1.0)).toBeLessThan(0.1); // the two non-empty sentences
  });

  test("starting a new read from file mode resets the previous session cleanly", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await startRead(page, "First short reading. It has two sentences.");
    await waitForFileMode(page);

    await page.fill("#text", "A new reading begins. It has different words. Three sentences now. Yes indeed.");
    await page.click("#readBtn");
    await expect(page.locator("#nowReading")).toContainText("A new reading begins");
    await expect(page.locator("#saveBtn")).toBeDisabled(); // reset while generating
    await waitForFileMode(page);
    await expect(page.locator("#statusLine")).toContainText("4 sentences");
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 4 * 0.4)).toBeLessThan(0.1);
    const streams = await page.evaluate(() => window.__TTS_STREAMS);
    expect(streams).toBe(2);
  });
});
