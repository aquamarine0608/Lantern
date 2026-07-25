const fs = require("fs");
const { test, expect, startRead, waitForFileMode, SAMPLE_TEXT } = require("../helpers/fixtures");

test.describe("basics and happy path", () => {
  test("loads in a clean idle state", async ({ page }) => {
    await page.goto("/#paste");
    await expect(page.locator("#modelStateText")).toHaveText("voice model not loaded");
    await expect(page.locator("#count")).toHaveText("0 words");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#banner")).toBeHidden();
  });

  test("word count updates and Clear works", async ({ page }) => {
    await page.goto("/#paste");
    await page.fill("#text", "hello world there");
    await expect(page.locator("#count")).toHaveText("3 words");
    await page.fill("#text", "hello");
    await expect(page.locator("#count")).toHaveText("1 word");
    await page.click("#clearBtn");
    await expect(page.locator("#count")).toHaveText("0 words");
    await expect(page.locator("#text")).toHaveValue("");
  });

  test("Read with empty text stays idle", async ({ page }) => {
    await page.goto("/#paste");
    await page.click("#readBtn");
    await page.fill("#text", "   \n  ");
    await page.click("#readBtn");
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
  });

  test("full flow: model download banner → generation → live playback → file mode → valid WAV", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 500, chunkDelay: 250, chunkSeconds: 0.8 });
    await page.goto("/#paste");
    await startRead(page);

    // generating UI
    await expect(page.locator("#readBtn")).toHaveText("Stop reading");
    await expect(page.locator("#player")).toBeVisible();
    await expect(page.locator("#nowReading")).toContainText("The lantern glows");

    // model download banner with progress, then ready
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText(/Downloading voice model|First run/);
    await expect(page.locator("#banner")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator("#modelStateText")).toHaveText("voice model ready");

    // streaming progress, completion, then hand-off to seekable file mode
    await expect(page.locator("#statusLine")).toContainText(/Reading aloud — sentence/, { timeout: 15_000 });
    await expect(page.locator("#statusLine")).toContainText("Finished generating", { timeout: 15_000 });
    await waitForFileMode(page);
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#saveBtn")).toBeEnabled();
    await expect(page.locator("#statusLine")).toContainText("3 sentences");
    await expect(page.locator("#tTotal")).toHaveText("0:02");

    // the underlying audio file must hold all three sentences (3 × 0.8 s)
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 2.4)).toBeLessThan(0.1);

    // Save WAV produces a valid 24 kHz 16-bit mono RIFF file of the full length
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#saveBtn")]);
    expect(download.suggestedFilename()).toMatch(/^lantern-.*\.wav$/);
    const buf = fs.readFileSync(await download.path());
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.readUInt32LE(24)).toBe(24000); // sample rate
    expect(buf.readUInt32LE(40)).toBe(Math.round(3 * 0.8 * 24000) * 2); // data bytes
  });

  test("file mode: play restarts, pause pauses, ended resets the icon", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.goto("/#paste");
    await startRead(page);
    await waitForFileMode(page);

    // finished playback sits paused at the end, showing the play icon
    await expect(page.locator("#iconPlay")).toBeVisible();
    expect(await page.evaluate(() => document.querySelector("audio").paused)).toBe(true);

    // play → restarts from the top
    await page.click("#playBtn");
    await expect(page.locator("#iconPause")).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.querySelector("audio").paused))
      .toBe(false);

    // pause
    await page.click("#playBtn");
    await expect(page.locator("#iconPlay")).toBeVisible();
    expect(await page.evaluate(() => document.querySelector("audio").paused)).toBe(true);

    // play to the natural end: the icon must flip back to "play" by itself
    await page.click("#playBtn");
    await expect(page.locator("#iconPause")).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => document.querySelector("audio").ended), { timeout: 10_000 })
      .toBe(true);
    await expect(page.locator("#iconPlay")).toBeVisible();
  });

  test("a space-free CJK paste gets a bounded excerpt, not the whole text as its title", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    const cjk = "夜が明けて空は青く光り始めた".repeat(40) + "。"; // 561 chars, no spaces anywhere
    await startRead(page, cjk);
    // split(/\s+/) yields ONE token for CJK, so a word cap alone would put all
    // 561 characters into the now-reading line and the lock-screen title
    const shown = await page.locator("#nowReading").textContent();
    expect(shown.length).toBeLessThanOrEqual(65);
    await expect
      .poll(() => page.evaluate(() => (navigator.mediaSession.metadata?.title || "").length), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const titleLen = await page.evaluate(() => (navigator.mediaSession.metadata?.title || "").length);
    expect(titleLen).toBeLessThanOrEqual(65);
    await waitForFileMode(page, 20_000);
  });

  test("file mode: tapping the wave seeks", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 1.0 });
    await page.goto("/#paste");
    await startRead(page);
    await waitForFileMode(page);

    const box = await page.locator("#wave").boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    const t = await page.evaluate(() => document.querySelector("audio").currentTime);
    expect(t).toBeGreaterThan(1.2); // ~50% of a 3 s file
    expect(t).toBeLessThan(1.9);
  });
});
