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

  test("stop during the model download returns to idle immediately", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 3000, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await startRead(page);
    await expect(page.locator("#readBtn")).toHaveText("Stop reading");
    await page.click("#readBtn"); // the download can't be cancelled — but the UI must not wedge on "Stopping…"
    await expect(page.locator("#readBtn")).toHaveText("Read aloud", { timeout: 2000 });
    await expect(page.locator("#player")).toBeHidden();
    // and once the (background) download lands, reading works instantly
    await page.waitForTimeout(3200);
    await startRead(page);
    await waitForFileMode(page);
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
    // …and it says so, instead of the player silently flashing open and shut
    await expect(page.locator("#bannerText")).toContainText("isn't producing any audio");
  });

  test("stop during the audio-session activation tears down cleanly", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 3000, chunkDelay: 50, chunkSeconds: 0.4 });
    // make ctx.resume() a REAL await, like iOS activating the audio session
    await page.addInitScript(() => {
      const orig = AudioContext.prototype.resume;
      AudioContext.prototype.resume = function () {
        return new Promise((r) => setTimeout(() => r(orig.call(this)), 600));
      };
    });
    await page.goto("/#paste");
    await startRead(page);
    await page.waitForTimeout(200); // inside the resume await, BEFORE qrWarmToken is armed
    await page.click("#readBtn"); // Stop
    // must return to idle promptly — not sit on a dead "Stopping…" while the model downloads
    await expect(page.locator("#readBtn")).toHaveText("Read aloud", { timeout: 2_000 });
    await expect(page.locator("#player")).toBeHidden();
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).not.toBe("playing");
    await expect(page.locator("#banner")).toBeHidden(); // no "First run: downloading" raised after the cancel
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

  test("leaving the paste view mid-generation aborts cleanly with no stray error", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 400, chunkSeconds: 0.5 });
    await page.goto("/#paste");
    await startRead(page, LONG_TEXT);
    await expect(page.locator("#statusLine")).toContainText(/sentence/, { timeout: 15_000 });
    await page.click("#pasteBackBtn"); // navigate away while the stream is running
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await page.waitForTimeout(1500); // give a zombie stream time to misbehave, if it were going to
    await expect(page.locator("#banner")).toBeHidden();

    // and the paste view is immediately reusable
    await page.click("#pasteModeBtn");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await startRead(page);
    await waitForFileMode(page);
  });

  test("an orphaned paste session can never interleave into a new one", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 600, chunkSeconds: 0.5 });
    await page.goto("/#paste");
    await startRead(page, LONG_TEXT); // eight sentences, one every 600 ms
    await expect(page.locator("#statusLine")).toContainText(/sentence/, { timeout: 15_000 });
    await page.click("#pasteBackBtn"); // orphan the session mid-stream
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await page.click("#pasteModeBtn"); // come straight back before the orphan's next chunk lands
    await startRead(page, "Short new text here. Just two sentences.");
    await waitForFileMode(page);
    await expect(page.locator("#statusLine")).toContainText("2 sentences");
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 1.0)).toBeLessThan(0.1); // only the new text — nothing interleaved
  });

  test("the silent-switch hint stays up until the live stream is swapped for the file", async ({ page, mockTTS }) => {
    // fast generation, slow audio: done-live lasts ~6 s and the element is STILL fed
    // by the muted-under-silent-switch MediaStream for all of it
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 3.0 });
    await page.goto("/#paste");
    await startRead(page, "One. Two.");
    await expect(page.locator("#statusLine")).toContainText("ready to save", { timeout: 10_000 });
    await expect(page.locator("#playerHint")).toBeVisible(); // the condition it explains persists
    await waitForFileMode(page, 20_000);
    await expect(page.locator("#playerHint")).toBeHidden(); // ends exactly at the handoff
  });

  test("the file-mode status reports the audio's length, not the generation wall time", async ({ page, mockTTS }) => {
    // synthesis slower than playback: the live timeline accumulates real gaps that
    // the concatenated file (and Save WAV) do not contain
    await mockTTS({ loadDelay: 20, chunkDelay: 900, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await startRead(page, "One here. Two here. Three here.");
    await waitForFileMode(page, 30_000);
    const tTotal = (await page.locator("#tTotal").textContent()).trim();
    await expect(page.locator("#statusLine")).toContainText(`· ${tTotal} ·`); // the two lengths agree
  });

  test("Save WAV is available the moment generation finishes, while audio is still playing", async ({ page, mockTTS }) => {
    // fast generation, slow audio: 2 sentences generate in ~100 ms but play for 6 s
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 3.0 });
    await page.goto("/#paste");
    await startRead(page, "One. Two.");
    await expect(page.locator("#statusLine")).toContainText("ready to save", { timeout: 10_000 });
    await expect(page.locator("#saveBtn")).toBeEnabled(); // NOT gated on playback draining
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    // and the normal hand-off to file mode still happens when playback ends
    await waitForFileMode(page, 20_000);
  });

  test("starting a new read from file mode resets the previous session cleanly", async ({ page, mockTTS }) => {
    // chunkDelay 250 keeps the mid-generation window wide enough to observe the
    // disabled save button (it now enables at done-live, not only in file mode)
    await mockTTS({ loadDelay: 20, chunkDelay: 250, chunkSeconds: 0.4 });
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
    // per-unit synthesis: 2 sentences in the first read + 4 in the second
    const calls = await page.evaluate(() => window.__TTS_GEN || 0);
    expect(calls).toBe(6);
  });

  test("a pause during the audio-session activation sticks — the publish honours it", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 3000, chunkDelay: 50, chunkSeconds: 0.4 });
    // activation is a REAL await on iOS: the context starts (and runs) immediately,
    // but the promise resolves late — a pause tap fits inside that window
    await page.addInitScript(() => {
      const origResume = AudioContext.prototype.resume;
      AudioContext.prototype.resume = function () {
        const p = origResume.call(this);
        return new Promise((r) => setTimeout(() => r(p), 600));
      };
      const OrigAC = window.AudioContext;
      window.AudioContext = class extends OrigAC {
        constructor(...a) { super(...a); window.__lastCtx = this; }
      };
    });
    await page.goto("/#paste");
    await startRead(page);
    await page.waitForFunction(() => window.__lastCtx && window.__lastCtx.state === "running");
    await page.click("#playBtn"); // pause — suspends the context immediately
    await page.waitForTimeout(900); // the activation await resolves in here
    // the transport publish must keep the pause, not overwrite it with "playing"
    expect(await page.evaluate(() => window.__lastCtx.state)).toBe("suspended");
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");
    await expect(page.locator("#playBtn")).toHaveAttribute("aria-label", "Play");
    // and resuming from that pause continues into a normal session
    await page.click("#playBtn");
    await waitForFileMode(page);
  });

  test("finishing generation while paused says 'paused', not 'still playing'", async ({ page, mockTTS }) => {
    // synthesis deliberately continues through a pause — the terminal done-live
    // status must reflect the transport's real state, not assert "still playing"
    await mockTTS({ loadDelay: 20, chunkDelay: 300, chunkSeconds: 2.0 });
    await page.goto("/#paste");
    await startRead(page, "First long sentence here. Second long sentence here. Third long sentence here.");
    await expect(page.locator("#statusLine")).toContainText(/sentence/, { timeout: 15_000 });
    await page.click("#playBtn"); // pause mid-generation — the context suspends
    await expect(page.locator("#statusLine")).toContainText("Finished generating", { timeout: 15_000 });
    await expect(page.locator("#statusLine")).toContainText("paused · ready to save");
    await expect(page.locator("#statusLine")).not.toContainText("still playing");
    await page.click("#playBtn"); // resume — the line follows the transport
    await expect(page.locator("#statusLine")).toContainText("still playing");
  });
});
