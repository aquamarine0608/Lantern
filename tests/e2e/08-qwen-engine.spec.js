const { test, expect, startRead, waitForFileMode } = require("../helpers/fixtures");
const { importEpub } = require("../helpers/epub");
const { setQwenOffline, setQwenHang, setQwenFail, setQwenRate, setQwenDelay, getQwenRequests } = require("../helpers/net");
const { makeEpub } = require("../helpers/epub");

const QWEN_URL = "http://127.0.0.1:4174";

/* Switch the app to the Qwen3-TTS server engine through the real settings UI. */
async function enableQwen(page, url = QWEN_URL) {
  await page.click("#libVoiceBtn");
  await page.click('#engineBtns button[data-e="qwen"]');
  await page.fill("#qwenUrl", url);
  await page.locator("#qwenUrl").blur();
  await page.click(".sheet:not([hidden]) .sheet-done");
}

const speakingSi = async (page) => {
  const el = page.locator(".sent.speaking");
  return (await el.count()) ? Number(await el.first().getAttribute("data-si")) : -1;
};

test.describe("Qwen3-TTS server engine", () => {
  test.afterEach(async () => {
    await setQwenOffline(false);
    await setQwenHang(false);
    await setQwenFail(false);
    await setQwenRate(22050);
    await setQwenDelay(0);
  });

  test("pasting the full endpoint URL still works — the path is not doubled", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page, QWEN_URL + "/v1/audio/speech"); // what the settings hint itself names
    await page.click("#pasteModeBtn");
    await startRead(page, "Only one sentence here.");
    await waitForFileMode(page);
  });

  test("an HTTP error from the server names the status instead of blaming the network", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await setQwenFail(true);
    await page.click("#pasteModeBtn");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("reported an error (500)", { timeout: 15_000 });
    await expect(page.locator("#bannerText")).not.toContainText("HTTPS and CORS"); // the server WAS reached
    await expect(page.locator("#player")).toBeHidden();
  });

  test("a suspend mid-edit never overwrites the committed server address", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    // half-typed text sitting in the field, never committed (no focus, no change event)
    await page.evaluate(() => { document.getElementById("qwenUrl").value = "http://127.0.0.1:41"; });
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);

    await page.reload();
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · server voice"); // live config intact
    await page.click("#libVoiceBtn");
    await expect(page.locator("#qwenUrl")).toHaveValue("http://127.0.0.1:41"); // the draft is preserved for finishing
    await page.click(".sheet:not([hidden]) .sheet-done");

    // and reading still uses the committed address
    await page.click("#pasteModeBtn");
    await startRead(page, "One sentence only here.");
    await waitForFileMode(page);
  });

  test("a draft typed before any commit becomes the live address on relaunch", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    // typed but never committed — then the app is suspended
    await page.evaluate((u) => { document.getElementById("qwenUrl").value = u; }, QWEN_URL);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

    await page.reload();
    // nothing committed existed to protect, so the draft must be adopted, not dead-ended
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · server voice");
    await page.click("#pasteModeBtn");
    await startRead(page, "One sentence only here.");
    await waitForFileMode(page);
  });

  test("a one-chapter silent book parks with an explanation, not 'the end'", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 30, chunkSeconds: 0 });
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "tiny-silent.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Tiny Silent", chapters: [{ title: "Only Chapter", paras: ["One line here."] }] }),
    });
    await page.click(".book");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("isn't producing any audio", { timeout: 20_000 });
    await expect(page.locator("#rStatus")).not.toContainText("the end");
  });

  test("48 kHz server audio is downsampled to the pipeline rate correctly", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await setQwenRate(48000);
    await page.click("#pasteModeBtn");
    await startRead(page, "First sentence here. Second sentence here.");
    await waitForFileMode(page);
    const duration = await page.evaluate(() => document.querySelector("audio").duration);
    expect(Math.abs(duration - 1.0)).toBeLessThan(0.12); // 2 × 0.5 s regardless of source rate
  });

  test("a book that synthesizes to silence parks instead of racing to 'the end'", async ({ page, mockTTS }) => {
    // kokoro engine with every chunk empty: the reader must not fast-forward the book
    await mockTTS({ loadDelay: 20, chunkDelay: 30, chunkSeconds: 0 });
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "silent.epub", mimeType: "application/epub+zip", buffer: makeEpub({ title: "Silent Book" }),
    });
    await page.click(".book");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("isn't producing any audio", { timeout: 20_000 });
    await expect(page.locator("#rIconPlay")).toBeVisible();
    await expect(page.locator("#rStatus")).not.toContainText("the end");
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
    await expect(page.locator("#bannerText")).toContainText("Couldn't reach your Qwen3-TTS server", { timeout: 15_000 });
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
    await page.click(".sheet:not([hidden]) .sheet-done");

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
    await page.click(".sheet:not([hidden]) .sheet-done");
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
    await page.click(".sheet:not([hidden]) .sheet-done");

    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await expect(page.locator("#rIconPlay")).toBeVisible();
    await expect(page.locator("#rStatus")).not.toContainText("generating on-device");
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");
    // the OS transport must not be left claiming "playing" over a silent stream
    expect(await page.evaluate(() => document.querySelector("audio").paused)).toBe(true);

    // configuring the server and tapping play recovers in place
    await page.click("#fontBtn");
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
  });

  test("the footer's privacy claim tracks the engine", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#appFooter")).toContainText("Runs entirely on this device");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect(page.locator("#appFooter")).toContainText("streamed from your server");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="kokoro"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect(page.locator("#appFooter")).toContainText("Runs entirely on this device");
  });

  test("the empty shelf's privacy line tracks the engine too", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#libEmpty")).toContainText("entirely on this device");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect(page.locator("#libEmpty")).toContainText("streamed from your server");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="kokoro"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect(page.locator("#libEmpty")).toContainText("entirely on this device");
  });

  test("a server error banner dies when the engine or the view changes", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]'); // no server URL entered
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");

    // switching back to the on-device engine invalidates the error — the chip says
    // "voice model ready" and the banner must not contradict it
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="kokoro"]');
    await expect(page.locator("#banner")).toBeHidden();
    await page.click(".sheet:not([hidden]) .sheet-done");

    // raise it again, then leave the reader: it must not follow into the library
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await page.click("#backBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await expect(page.locator("#banner")).toBeHidden();
  });

  test("an engine round-trip during the model download brings the progress banner back", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 4000, progressSteps: 1, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#rPlay"); // the download starts, banner up
    await expect(page.locator("#banner")).toBeVisible();
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]'); // hides the download banner, parks with its own error
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await page.click('#engineBtns button[data-e="kokoro"]'); // clears the qwen error
    await expect(page.locator("#banner")).toBeHidden();
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#rPlay"); // joins the STILL-in-flight load — the banner must resurface
    await expect(page.locator("#bannerText")).toContainText(/voice model/i);
    // a non-error banner floats above an open sheet too (the sheet can start the download)
    await page.click("#fontBtn");
    expect(await page.evaluate(() => getComputedStyle(document.getElementById("banner")).position)).toBe("fixed");
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
  });

  test("a tapped sentence is highlighted immediately, even when the engine fails to warm up", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]'); // no server URL entered
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click('.sent[data-si="2"]');
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    // the amber marker must sit on the tapped sentence — where rd.si and the retry target are
    await expect(page.locator(".sent.speaking")).toHaveAttribute("data-si", "2");
  });

  test("typing in the server field never disturbs the chapter being read", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 1.5 });
    await page.goto("/");
    await enableQwen(page);
    await importEpub(page);
    await page.click(".book");
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);

    await page.click("#fontBtn");
    await page.locator("#qwenUrl").press("End");
    await page.locator("#qwenUrl").press("9"); // half-typed edit, not committed
    await page.waitForTimeout(600);
    await expect(page.locator("#setSheet")).toBeVisible(); // no error yanked it away
    await expect(page.locator("#banner")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL); // stored address untouched
    await expect(page.locator("#rIconPause")).toBeVisible(); // still reading
  });

  test("degenerate server addresses never count as configured", async ({ page }) => {
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    for (const bad of ["https://", "/v1/audio/speech", "///"]) {
      await page.fill("#qwenUrl", bad);
      await page.locator("#qwenUrl").blur();
      await expect(page.locator("#qwenUrl")).toHaveValue(""); // normalized away, not kept as "https:"
      await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · set server address");
    }
  });

  /* normalizeServerUrl returns "" for an intentional clear AND for text it simply
     cannot parse. Committing the second as the first deletes a working address from
     qwenServer, localStorage and the draft at once — silent and irreversible. */
  test("unparseable Server text never deletes a working address", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenUrl", "https://"); // scheme only — nothing the parser can use
    await page.locator("#qwenUrl").blur();

    // the working address survives everywhere, and the half-typed text stays put
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    await expect(page.locator("#qwenUrl")).toHaveValue("https://");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    await expect(page.locator("#qwenDraftNote")).toBeVisible();
    await expect(page.locator("#qwenDraftNoteText")).toContainText("reading still uses");
    // the refusal is otherwise invisible, so it is announced
    await expect
      .poll(() => page.evaluate(() => document.getElementById("a11yAlert").textContent), { timeout: 5_000 })
      .toContain("reading still uses");
    // …and the chip stays honest: the live config was never touched
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · server voice");

    // an EMPTY field is a different gesture — the intentional clear still commits
    await page.fill("#qwenUrl", "");
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe("");
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · set server address");
  });

  test("switching engines mid-paste stops the server session instead of lying about it", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await setQwenHang(true); // the in-flight request never answers — the session is clearly live
    await page.click("#pasteModeBtn");
    await startRead(page, "One sentence here. Two sentences here. Three sentences here.");
    await expect(page.locator("#readBtn")).toHaveText("Stop reading");
    await page.waitForTimeout(400); // the first POST is now hung in flight

    await page.click("#pasteVoiceBtn");
    await page.click('#engineBtns button[data-e="kokoro"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    // the live session stops like Stop — the footer's claim is true again
    await expect(page.locator("#readBtn")).toHaveText("Read aloud", { timeout: 10_000 });
    await expect(page.locator("#appFooter")).toContainText("Runs entirely on this device");
    const before = (await getQwenRequests()).length;
    await page.waitForTimeout(800); // a zombie generator would keep POSTing sentences here
    expect((await getQwenRequests()).length).toBe(before);
  });

  test("a draft voice and key restored before any commit become live on relaunch", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "sage", k: "sk-test-123" }));
    }, QWEN_URL);
    await page.goto("/#paste");
    // all three fields adopted (nothing was ever committed), draft cleared
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("sage");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-test-123");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).toBeNull();
    // and synthesis actually uses the restored voice — not a default the field contradicts
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].voice).toBe("sage");
  });

  test("a draft for a DIFFERENT server never leaks its key to the committed one", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url); // a WORKING committed server
      // an interrupted edit for some other host, key typed for THAT host
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://other-host.example", v: "othervoice", k: "sk-for-other-host" }));
    }, QWEN_URL);
    await page.goto("/#paste");
    // the refused draft's key and voice must NOT be committed against the old server
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull(); // the edit is kept, not lost
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    const last = reqs[reqs.length - 1];
    expect(last.__auth).toBeNull(); // no Bearer token went to the committed host
    expect(last.voice).not.toBe("othervoice");
  });

  test("committing only the key adopts the address shown beside it — never the previous one", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://old-host.example");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "" })); // new address, restored pristine
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-new-key");
    await page.locator("#qwenKey").blur(); // REFUSED: the shown address was restored, never confirmed
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe("https://old-host.example");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBeNull();
    // confirming the address (any real input) commits the whole triple together
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    await page.click(".sheet:not([hidden]) .sheet-done");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new-key");
    // and the request proves URL and key travel together
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-new-key");
  });

  test("a key committed beside an EMPTIED address never re-targets the live server", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url); // a WORKING committed server
      localStorage.setItem("lantern.qwenKey", "sk-old");
      // interrupted edit: the address was deleted, the app suspended before blur
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "", v: "cherry", k: "sk-old" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-for-the-new-host");
    await page.locator("#qwenKey").blur(); // must refuse: the shown address is empty
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-old"); // not adopted
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL); // not wiped
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull(); // edit kept
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-old"); // the new host's key never reached the old one
  });

  test("a sibling commit never promotes a restored address the user did not touch", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url); // the working server
      // a half-typed address parked in the draft — normalizeServerUrl can't tell it's incomplete
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://half-typed.exa", v: "", k: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-whatever");
    await page.locator("#qwenKey").blur(); // must NOT silently retarget the server as a side effect
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBeNull(); // key waits for the address
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
  });

  test("dismissing the sheet never commits a refused restored address", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url); // the working server
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://half-typed.exa", v: "", k: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-x");
    await page.locator("#qwenKey").blur(); // refuse path parks the caret in the Server field…
    await page.keyboard.press("Escape"); // …and the dismissal blurs it — that blur must NOT commit
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
  });

  test("a key refused beside an emptied address rides along when the SAME address is restored", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "", v: "", k: "" })); // address deleted mid-edit
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-new");
    await page.locator("#qwenKey").blur(); // refused: shown address is empty
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBeNull();
    await page.fill("#qwenUrl", QWEN_URL); // the user restores the SAME live address
    await page.locator("#qwenUrl").blur(); // the parked key must ride along now
    await page.click(".sheet:not([hidden]) .sheet-done");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-new");
  });

  test("a key typed beside another host's address never commits when the LIVE address is restored", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://new-box.example", v: "", k: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-new-box"); // typed while the NEW box's address is shown
    await page.locator("#qwenKey").blur(); // refused — and the refusal is now announced
    await expect(page.locator("#bannerText")).toContainText("Not saved yet");
    await page.fill("#qwenUrl", QWEN_URL); // the user restores the LIVE address instead
    await page.locator("#qwenUrl").blur();
    // the key was typed for the other host: it must NOT pair with the live one
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    // trying to commit the parked key now names the REAL remedy (not "confirm the address")
    await page.locator("#qwenKey").focus();
    await page.locator("#qwenKey").blur();
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    // …and following it works: retyping the key stamps it for the shown (live) address
    await page.fill("#qwenKey", "sk-live-2");
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live-2");
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-live-2");
  });

  test("a focus-and-leave of the key or voice field never promotes draft values", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-tru", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.locator("#qwenKey").focus();
    await page.locator("#qwenKey").blur(); // zero keystrokes — a script-restored value must not go live
    await page.locator("#qwenVoice").focus();
    await page.locator("#qwenVoice").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("ethan");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    // typing IS engagement: finishing the key commits it
    await page.fill("#qwenKey", "sk-finished");
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-finished");
  });

  test("a key parked for another host never goes live after a relaunch", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    // what the app itself persists after the cross-host refusal: the draft's address
    // was rewritten to the live one, but the stamp (b) still names the other host
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url); // live host — no key ever committed
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-for-host-b", b: "https://host-b.example" }));
    }, QWEN_URL);
    await page.goto("/#paste");
    // the boot adoption must honour the persisted provenance, not the rewritten address
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBeNull(); // host B's token never reached host A
  });

  test("a focus-and-leave of the Server field never promotes draft values over working ones", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // a mid-edit draft for the SAME address, holding a truncated key
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-trunc" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.locator("#qwenUrl").focus();
    await page.locator("#qwenUrl").blur(); // zero keystrokes — the blur contract says no-op
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("ethan");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
  });

  test("a fresh install commits no default voice, so a later draft voice can still be adopted", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    // the boot adoption must not write the untouched default and poison its own gate
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBeNull();
  });

  test("a committed-then-cleared key never blocks adopting a drafted replacement", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", ""); // committed ABSENCE — the user cleared it once
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-new" }));
    }, QWEN_URL);
    await page.goto("/#paste");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new"); // adopted
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-new");
  });

  test("changing the voice mid-paste-reading finishes the session in the voice it started with", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await enableQwen(page);
    await setQwenDelay(400); // slow the server so the session is still running mid-edit
    await page.click("#pasteModeBtn");
    await startRead(page, "One here. Two here. Three here. Four here. Five here. Six here.");
    await expect(page.locator("#statusLine")).toContainText(/sentence/, { timeout: 15_000 });
    await page.click("#pasteVoiceBtn");
    await page.fill("#qwenVoice", "sage");
    await page.locator("#qwenVoice").blur(); // committed mid-reading
    await page.click(".sheet:not([hidden]) .sheet-done");
    await setQwenDelay(0);
    await waitForFileMode(page, 20_000);
    const reqs = (await getQwenRequests()).filter((r) => typeof r.input === "string" && r.input.includes("here"));
    // one reading = one voice: no request switched to the new voice mid-flight
    for (const r of reqs) expect(r.voice).toBe("cherry");
    // the NEXT reading uses the committed voice
    await startRead(page, "Fresh text now.");
    await waitForFileMode(page);
    const after = await getQwenRequests();
    expect(after[after.length - 1].voice).toBe("sage");
  });

  test("committing a corrected voice clears the error that demanded the correction", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]'); // no server URL
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await page.click("#fontBtn");
    await page.fill("#qwenVoice", "sage");
    await page.locator("#qwenVoice").blur(); // commit — the parked error described the OLD config
    await expect(page.locator("#banner")).toBeHidden();
  });

  test("the paste view can open Voice settings to fix a server error in place", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript(() => localStorage.setItem("lantern.engine", "qwen"));
    await page.goto("/#paste");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    // the error's instruction must not be a dead end — Voice settings open right here
    await page.click("#pasteVoiceBtn");
    await expect(page.locator("#setSheet")).toBeVisible();
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    await expect(page.locator("#banner")).toBeHidden(); // committing the address clears the error
    await page.click(".sheet:not([hidden]) .sheet-done");
    await startRead(page);
    await waitForFileMode(page);
  });

  test("without a server address, reading explains what to do instead of hanging", async ({ page }) => {
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    await page.click(".sheet:not([hidden]) .sheet-done"); // no URL entered
    await expect(page.locator("#modelStateText")).toHaveText("qwen3-tts · set server address");

    await page.click("#pasteModeBtn");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();
    // the bail-out must not leave the OS transport claiming "playing"
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");
  });

  test("a third address never adopts a key stamped for a second host — but that host still can", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://host-a.example");
      localStorage.setItem("lantern.qwenKey", "sk-A");
      // an interrupted edit: host B's address and key, stamped for host B
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-B", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenUrl", "https://host-c.example"); // a THIRD host
    await page.locator("#qwenUrl").blur();
    // committing C is engagement with the ADDRESS — host B's key must not ride to C
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe("https://host-c.example");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-A");
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    // committing the address the key WAS stamped for releases it
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-B");
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-B");
  });

  test("reopening settings names a held key, and a same-address keystroke never adopts it", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // what the app persists after a cross-host refusal: the draft address was
      // rewritten to the live one, but the key's stamp still names the other host
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-for-b", b: "https://host-b.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // the held key is reported the moment the sheet opens — not only on a blur
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    // a keystroke that only re-normalizes the SAME address is not adoption authority
    await page.locator("#qwenUrl").focus();
    await page.keyboard.press("End");
    await page.keyboard.type("/");
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-live"); // host B's key never leaked
  });

  test("the settings sheet names the address reading actually uses, and one tap adopts the shown one", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://old-host.example");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "" })); // unfinished address edit
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#qwenDraftNote")).toBeVisible();
    await expect(page.locator("#qwenDraftNoteText")).toContainText("reading still uses https://old-host.example");
    await page.click("#qwenUseShown"); // adopt the shown address without retyping it
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    await expect(page.locator("#qwenDraftNote")).toBeHidden();
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page); // …and reading actually uses it
  });

  /* .sheet is bottom-anchored, so every height change inside it is paid for out of
     the sheet's TOP edge. The divergence note collapses from the Server field's blur
     commit — i.e. inside press 1 of the very tap aimed at Done / Engine / A+ — and
     used to slide the target ~68 px down before mouseup, so the click retargeted to
     the sheet body and the tap did nothing at all (while the address committed
     silently). It took a second tap to reach the control the user had aimed at.
     { delay: 80 } is the point of these two: a 0 ms synthetic press is dispatched as
     one burst, so it passed even against a one-frame deferral. A real mouse press is
     50–150 ms — many frames — and only holding the collapse until pointerup survives it. */
  test("committing the server address by tapping Done does not eat that tap", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.setViewportSize({ width: 390, height: 844 }); // under the 70dvh cap, so the top edge really moves
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://old-host.example");
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // typed, not script-restored: only a touched field blur-commits, and only a
    // commit collapses the note
    await page.fill("#qwenUrl", QWEN_URL);
    await expect(page.locator("#qwenDraftNote")).toBeVisible();
    await page.click(".sheet:not([hidden]) .sheet-done", { delay: 80 }); // ONE real-length press, focus still in the field
    await expect(page.locator("#sheetBackdrop")).toBeHidden(); // used to need a second tap
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
  });

  test("…and the same tap on the engine buttons still switches the engine", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://old-host.example");
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenUrl", QWEN_URL);
    await expect(page.locator("#qwenDraftNote")).toBeVisible();
    await page.click('#engineBtns button[data-e="kokoro"]', { delay: 80 }); // ONE real-length press, focus still in the field
    expect(await page.evaluate(() => localStorage.getItem("lantern.engine"))).toBe("kokoro");
    await expect(page.locator("#qwenCfg")).toBeHidden();
  });

  test("a same-host unfinished key edit is named as such when settings reopen", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // an unfinished key edit for the SAME host — no address mismatch to blame
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-tru", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    // the live key is untouched; finishing the edit commits it
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    await page.fill("#qwenKey", "sk-finished");
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-finished");
  });

  test("a voice keystroke never rewrites the KEY's provenance — the parked key stays parked", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://host-a.example");
      localStorage.setItem("lantern.qwenKey", "sk-A");
      // a parked key typed for x.example, draft address since rewritten to url
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-x", b: "https://x.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // typing a VOICE stamps only the voice's provenance — a shared stamp used to
    // re-pair the key with the shown address here, releasing it to the wrong host
    await page.fill("#qwenVoice", "ethan");
    await page.click("#qwenUseShown"); // commit the shown address
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("ethan"); // the user's own act rides
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-A"); // x.example's key does NOT
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await startRead(page);
    await waitForFileMode(page);
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-A"); // never sk-x
    expect(reqs[reqs.length - 1].voice).toBe("ethan");
  });

  test("a key typed beside NO address is an unfinished edit — never called cross-host", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-old");
      // the natural order: clear the address, type the new key, get suspended
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "", v: "", k: "sk-new", b: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // the emptied Server field blocks every sibling commit, so "type them again"
    // would be a guaranteed no-op here — the address is the only remedy that moves,
    // and it is what the blur refusals say too (proved in the degenerate-field test)
    await expect(page.locator("#bannerText")).toContainText("Confirm the Server address");
    // confirming the live address holds the pristine key and NAMES the remedy that
    // now works — there is no "other address" to restore, so it is a draft, not stale
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-old");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await expect(page.locator("#bannerText")).not.toContainText("different server address");
    // …and the remedy it names actually works: retyping commits
    await page.fill("#qwenKey", "sk-new");
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new");
  });

  test("restoring the live address replaces the now-impossible 'confirm the address' banner", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // a whole parked edit for another box: address + key, stamped for it
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://new-box.example", v: "", k: "sk-b", b: "https://new-box.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // on open, the promise is real: confirming new-box's address WOULD release sk-b
    await expect(page.locator("#bannerText")).toContainText("Confirm the Server address");
    // the user decides against the new box and restores the live address instead —
    // that banner's remedy is now impossible and must be replaced, not left standing
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
  });

  test("switching Engine to Qwen3-TTS inside an open sheet reports a held key immediately", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "kokoro"); // qwen fields hidden at open
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-shadow", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn"); // opens on kokoro — the shadow report bails here
    await expect(page.locator("#banner")).toBeHidden();
    await page.click('#engineBtns button[data-e="qwen"]'); // the fields become visible NOW
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live"); // shown ≠ used
  });

  test("the hold banner survives the reader restart the same gesture triggers", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "kokoro"); // reading starts on-device
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-shadow", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#rPlay");
    await expect(page.locator(".sent.speaking")).toHaveCount(1, { timeout: 15_000 });
    await page.click("#fontBtn"); // reader settings — engine kokoro, shadow report bails
    await expect(page.locator("#banner")).toBeHidden();
    // switching the engine restarts the PLAYING reader (readerSettingsChanged →
    // readerPlayFrom) and THEN raises the hold banner — the restart's async
    // clearErrorBanner used to wipe it milliseconds later
    await page.click('#engineBtns button[data-e="qwen"]');
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.waitForTimeout(1300); // the restart's warm-up settles in here
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
  });

  test("the hold banner survives the paste view's own Read tap", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-draft", b: url }));
    }, QWEN_URL);
    await page.goto("/#paste");
    await page.click("#pasteVoiceBtn"); // openSheet → reportQwenShadow
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect(page.locator("#banner")).toBeVisible();
    await startRead(page); // the tap must NOT answer the hold
    await waitForFileMode(page);
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    const reqs = await getQwenRequests(); // …and it really did read with the live pair
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-live");
    expect(reqs[reqs.length - 1].voice).toBe("ethan");
  });

  test("a typed-then-refused key is re-reported after a route change eats the banner", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://new-box.example", v: "", k: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenKey", "sk-typed"); // typed beside new-box's unconfirmed address
    await page.locator("#qwenKey").blur();
    await expect(page.locator("#bannerText")).toContainText("Confirm the Server address");
    await page.fill("#qwenUrl", QWEN_URL); // the user restores the live address instead
    await page.locator("#qwenUrl").blur();
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn"); // a route change answers no hold — it must survive
    await expect(page.locator("#banner")).toBeVisible(); // toContainText alone reads hidden text
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    // and if anything else ever does hide it, reopening settings must re-report a
    // TYPED hold, not only a script-restored one
    await page.evaluate(() => { document.getElementById("banner").hidden = true; });
    await page.click("#pasteVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
  });

  test("a successful book import never clears an unanswered hold banner", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-tru", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn"); // raises the unfinished-edit hold
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.click(".sheet:not([hidden]) .sheet-done");
    // the import's own post-await cleanup must only drop errors IT superseded
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
  });

  test("emptying the Server field never releases a key that was typed beside no address", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-A");
      // a pristine key drafted with NO address shown — the "" wildcard stamp
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "", v: "", k: "sk-evil", b: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // the user genuinely commits an EMPTY address ("" === "" must not count as
    // a provenance match — the old gate adopted the key and deleted the draft)
    await page.fill("#qwenUrl", "x");
    await page.fill("#qwenUrl", "");
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(""); // the emptying itself commits
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-A"); // the key does NOT ride
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull(); // edit kept
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
  });

  test("committing the voice never silently swallows a hold that describes the KEY", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // the KEY is parked for another host; the voice shown is the live one
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "ethan", k: "sk-for-b", bv: url, bk: "https://host-b.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    // a good voice commit answers ITS OWN error, not the one standing for the key
    await page.fill("#qwenVoice", "sage");
    await page.locator("#qwenVoice").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("sage"); // the commit really happened
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live"); // still shadowed
  });

  test("committing the key never silently swallows a hold that describes the VOICE", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // mirrored: the VOICE is parked for another host, the key shown is the live one
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-live", bv: "https://host-b.example", bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    await page.fill("#qwenKey", "sk-new");
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new");
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("ethan"); // still shadowed
  });

  test("a hold raised over a degenerate Server field names the address, not a retype that is refused", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // scheme-only Server field over a working server, key stamped with the "" wildcard
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "http://", v: "", k: "sk-draft", bv: "", bk: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // "type them again" cannot work here — commitShownServer refuses on an empty
    // shown address — so the hold must name the address instead
    await expect(page.locator("#bannerText")).toContainText("Confirm the Server address");
    const onOpen = await page.locator("#bannerText").innerHTML();
    // and the blur refusal must say the very same thing, not overwrite it
    await page.fill("#qwenKey", "sk-typed");
    await page.locator("#qwenKey").blur();
    expect(await page.locator("#bannerText").innerHTML()).toBe(onOpen);
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    // the remedy it names really does release the key
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-typed");
    await expect(page.locator("#banner")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).toBeNull();
  });

  test("a hold over a restored-but-unconfirmed address names the address, not a retype that is refused", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // a valid address the user never confirmed this session + a "" wildcard stamp
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://host-b.example", v: "", k: "sk-draft", bv: "", bk: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("Confirm the Server address");
    const onOpen = await page.locator("#bannerText").innerHTML();
    await page.fill("#qwenKey", "sk-typed"); // refused: the shown address is unconfirmed
    await page.locator("#qwenKey").blur();
    expect(await page.locator("#bannerText").innerHTML()).toBe(onOpen);
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
    // confirming the address is what unblocks it, exactly as the banner says
    await page.click("#qwenUseShown");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe("https://host-b.example");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-typed");
  });

  test("an unanswered hold survives the library→paste hop that used to eat it", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-draft", bv: url, bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.click(".sheet:not([hidden]) .sheet-done");
    // a route change answers nothing, and the hold's remedy is reachable from the
    // paste view too — without this the readBtn guard was already a no-op
    await page.click("#pasteModeBtn");
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    // …and back again
    await page.click("#pasteBackBtn");
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");
  });

  test("an unanswered hold survives the hop into a book, where a whole chapter would use it", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-draft", bv: url, bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    await importEpub(page);
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click(".book"); // library → reader
    await expect(page.locator("#rPlay")).toBeVisible();
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    // and the reading it starts really does use the live pair, not the shown one
    await page.click("#rPlay");
    await expect(page.locator(".sent.speaking")).toHaveCount(1, { timeout: 15_000 });
    const reqs = await getQwenRequests();
    expect(reqs[reqs.length - 1].__auth).toBe("Bearer sk-live");
    expect(reqs[reqs.length - 1].voice).toBe("ethan");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
  });

  /* the exemption keeps the hold standing across a route change — but the banner is
     the last in-flow element of .wrap, and the library's shelf is a natural-height
     grid, so on a full shelf the surviving banner landed hundreds of pixels below the
     fold with scrollY unchanged: the destination view showed a healthy chip, no inline
     note and no visible warning, which is the exact state the exemption exists to
     prevent. Nothing re-scrolled it, because showBanner only scrolls at RAISE time. */
  test("a hold that survives a route change is still on screen when the shelf overflows", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // a same-host unfinished key edit: the hold reading uses the live key, not this one
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-draft", bv: url, bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    for (let i = 1; i <= 8; i++) await importEpub(page, { name: `book${i}.epub`, title: `Shelf Filler ${i}` });
    await expect(page.locator(".book")).toHaveCount(8); // the shelf now overflows the viewport
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.click(".sheet:not([hidden]) .sheet-done");
    // a route change with the hold standing: library → paste → library
    await page.click("#pasteModeBtn");
    await expect(page.locator("#banner")).toBeInViewport();
    await page.click("#pasteBackBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await expect(page.locator("#banner")).toBeInViewport(); // used to be far below the fold
  });

  /* …and the reveal has to measure the layout the import LEAVES BEHIND. revealBanner()
     used to be the last statement of the import's try, with the `finally` restoring
     addBookBtn from "Adding…" to "Add a book · EPUB" immediately afterwards — a
     re-wrap of .lib-actions, which sits ABOVE the in-flow banner, so the banner the
     reveal had just scrolled flush with the fold dropped ~20 px (one whole line of it)
     back off screen. Chromium's scroll anchoring silently compensates, which is why
     the round-28 spec above never saw it; WebKit implements no scroll anchoring at
     all, and this is an iOS-first app. `overflow-anchor: none` reproduces WebKit. */
  test("the banner an import reveals is still fully on screen once the button label is back", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript(() => {
      const add = () => {
        const s = document.createElement("style");
        s.textContent = "* { overflow-anchor: none !important; }"; // WebKit has none
        (document.head || document.documentElement).appendChild(s);
      };
      if (document.head || document.documentElement) add();
      else document.addEventListener("DOMContentLoaded", add, { once: true });
    });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // same-host unfinished key edit: a hold that no import may clear
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-draft", bv: url, bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    for (let i = 1; i <= 8; i++) await importEpub(page, { name: `book${i}.epub`, title: `Shelf Filler ${i}` });
    await expect(page.locator(".book")).toHaveCount(8); // the shelf overflows the viewport
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await page.click(".sheet:not([hidden]) .sheet-done");
    // the import that reveals the standing hold — and then re-wraps the row above it
    await importEpub(page, { name: "book9.epub", title: "Shelf Filler 9" });
    await expect(page.locator(".book")).toHaveCount(9);
    await expect(page.locator("#addBookBtn")).toHaveText("Add a book · EPUB"); // the finally has run
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit"); // never cleared
    const box = await page.locator("#banner").boundingBox();
    const vh = page.viewportSize().height;
    expect(box.y + box.height).toBeLessThanOrEqual(vh + 1); // used to sit ~20px past the fold
  });

  test("answering a hold by retyping the live value takes it down — for good", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-old");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "", k: "sk-new", b: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    // abandoning the half-finished edit is the normal way out, and it changes no
    // value — so every clearErrorBanner in the commits (all inside a value-CHANGED
    // branch) is skipped, and the hold used to stand for the life of the page
    await page.fill("#qwenKey", "sk-old");
    await page.locator("#qwenKey").blur();
    await expect(page.locator("#banner")).toBeHidden();
    expect(await page.locator("#a11yAlert").textContent()).toBe(""); // nor left in the live region
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).toBeNull();
    // and it cannot come back: the route exemption and reportQwenShadow's early
    // return are exactly what made a stale one permanent
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#pasteModeBtn");
    await expect(page.locator("#banner")).toBeHidden();
    await page.click("#pasteVoiceBtn");
    await expect(page.locator("#banner")).toBeHidden();
  });

  test("a hold answered while the address is still blocked comes down too", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // a valid address the user never confirmed this session — every sibling
      // commit is refused, so the answer arrives through refuseSibling(false, …)
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://host-b.example", v: "", k: "sk-draft", bv: "", bk: "" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("Confirm the Server address");
    await page.fill("#qwenKey", "sk-live"); // the key shown is now the live one
    await page.locator("#qwenKey").blur();
    // nothing is held any more, so the banner's whole claim is false — even though
    // the commit itself was refused and no value changed
    await expect(page.locator("#banner")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe(QWEN_URL);
    // the unfinished ADDRESS edit is still parked, and the inline note still says so
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).not.toBeNull();
    await expect(page.locator("#qwenDraftNote")).toBeVisible();
  });

  test("a hold whose values were typed for a THIRD address names the remedy that works", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://host-a.example");
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // host-b sits unconfirmed in the Server field, but the pair was typed for host-c
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({
        u: "https://host-b.example", v: "newvoice", k: "sk-new",
        bv: "https://host-c.example", bk: "https://host-c.example",
      }));
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    // "confirm the Server address" would be a lie here: the ride gates are strict
    // equality against the STAMP, so committing host-b releases nothing
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    await expect(page.locator("#bannerText")).not.toContainText("Confirm the Server address");
    // the remedy it does name releases both in a single commit
    await page.fill("#qwenUrl", "https://host-c.example");
    await page.locator("#qwenUrl").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("newvoice");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenDraft"))).toBeNull();
    await expect(page.locator("#banner")).toBeHidden();
  });

  test("the hold re-raised after a successful commit never names the field just saved", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // only the VOICE is held; the key shown is the live one
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-live", bv: "https://host-b.example", bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("The voice showing here");
    await page.fill("#qwenKey", "sk-new"); // saving the key re-reports the VOICE's hold
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-new");
    await expect(page.locator("#banner")).toBeVisible();
    // the key WAS saved — a banner claiming otherwise is unverifiable behind type=password
    await expect(page.locator("#bannerText")).toContainText("The voice showing here");
    await expect(page.locator("#bannerText")).not.toContainText("API key");
  });

  test("the mirrored hold names only the key", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "ethan", k: "sk-for-b", bv: url, bk: "https://host-b.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenVoice", "sage"); // saving the voice re-reports the KEY's hold
    await page.locator("#qwenVoice").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("sage");
    await expect(page.locator("#bannerText")).toContainText("The API key showing here");
    await expect(page.locator("#bannerText")).not.toContainText("voice");
  });

  test("a genuinely held pair still says both — subjects, not per-field boilerplate", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: url, v: "cherry", k: "sk-draft", bv: url, bk: url }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText(
      "The voice and API key showing here are an unfinished edit — Lantern is still reading with the last ones you saved. Type them again to save them.");
  });

  /* Round 26 re-narrowed a pair hold only inside the commits' value-CHANGED branches.
     The other ways half a hold gets answered — reverting a field to its live value
     (the equal-value fallthrough) and the refusal exits that pass held=false — reached
     only clearQwenHold, which is all-or-nothing and returns while the sibling is still
     held. The pair wording then stood naming a field that matches live, and its "type
     it again" remedy was a guaranteed no-op there, so it never came down. */
  test("reverting the voice to its live value re-narrows the hold to the key alone", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({
        u: url, v: "cherry", k: "sk-draft", bv: "https://host-b.example", bk: "https://host-b.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("The voice and API key showing here");
    // put the LIVE voice back: no value CHANGES, so only the fallthrough runs
    await page.fill("#qwenVoice", "ethan");
    await page.locator("#qwenVoice").blur();
    await expect(page.locator("#banner")).toBeVisible(); // the key is genuinely still held
    await expect(page.locator("#bannerText")).toContainText("The API key showing here");
    await expect(page.locator("#bannerText")).not.toContainText("voice");
  });

  test("reverting the key to its live value re-narrows the hold to the voice alone", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({
        u: url, v: "cherry", k: "sk-draft", bv: "https://host-b.example", bk: "https://host-b.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("The voice and API key showing here");
    await page.fill("#qwenKey", "sk-live");
    await page.locator("#qwenKey").blur();
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("The voice showing here");
    await expect(page.locator("#bannerText")).not.toContainText("API key");
  });

  test("a hold half-answered on a REFUSED commit re-narrows too", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "ethan");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      // a restored-but-unconfirmed address: commitShownServer refuses the whole commit,
      // so the key blur exits through refuseSibling(held=false) without ever committing
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({
        u: "https://host-a.example", v: "zed", k: "sk-draft",
        bv: "https://host-a.example", bk: "https://host-a.example" }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("the voice and API key you typed are still waiting on it");
    await page.fill("#qwenKey", "sk-live"); // the key is no longer held; the voice still is
    await page.locator("#qwenKey").blur();
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator("#bannerText")).toContainText("the voice you typed is still waiting on it");
    await expect(page.locator("#bannerText")).not.toContainText("API key");
  });

  /* The reader's banner is position:fixed over the top of #rScroll, so it covers the
     first lines of the chapter — exactly where the failed sentence is parked. A remedy
     naming a sentence tap was therefore pointing at something the banner itself was
     intercepting. It must name the player, which the banner can never reach. */
  test("the reader's failure banner names a remedy its own float cannot cover", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto("/");
    await importEpub(page);
    await enableQwen(page);
    await setQwenFail(true); // the very first sentence fails, at scrollTop 0
    await page.click(".book");
    await page.click("#rPlay");

    await expect(page.locator("#bannerText")).toContainText("Tap play to try again.");
    await expect(page.locator("#bannerText")).not.toContainText("Tap a sentence");
    // the banner agrees with the status line the same park writes
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");

    // the remedy it names is genuinely reachable: the banner does not cover #rPlay...
    const covered = await page.evaluate(() => {
      const r = document.getElementById("rPlay").getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return document.getElementById("banner").contains(hit);
    });
    expect(covered).toBe(false);
    // ...while the sentence the old message pointed at IS underneath it
    const sentenceCovered = await page.evaluate(() => {
      const s = document.querySelector(".sent");
      const r = s.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return document.getElementById("banner").contains(hit);
    });
    expect(sentenceCovered).toBe(true);

    // and tapping play really does retry the parked sentence
    await setQwenFail(false);
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
  });

  /* The banner promises "Tap play to try again" the instant synthesis throws — but the
     park that makes play MEAN retry lives in finish()'s genFailed branch, which cannot
     run until every buffer scheduled before the failure has drained (up to the whole
     90 s backpressure window). Mid-drain the tap used to suspend the context and stop
     there: no new synthesis, and — because a suspended context freezes currentTime —
     onended never fired, so the park never arrived and the promised retry became
     unreachable. Round 28 turned that tap into an immediate retry, which fixed the
     dead end but broke the label: the control is still wearing the PAUSE glyph
     mid-drain, so the ONE thing the user could not do from inside the app was stop
     the audio. Both properties now hold — tap 1 parks (which is what the button
     says), tap 2 retries (which is what the banner says). The round-27 spec above
     only covers a sentence-1 failure, where nothing is scheduled and finish() parks
     immediately. */
  test("the failure banner's play tap retries even while earlier audio is still draining", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    // one long chapter: the qwen mock answers 0.5 s of audio per sentence, so a
    // generation that runs ahead of the clock piles up a real drain window
    const chapters = [
      { title: "A Long Chapter", paras: Array.from({ length: 8 }, (_, p) =>
        Array.from({ length: 5 }, (_, s) => `This is sentence ${p * 5 + s + 1} of the long first chapter.`).join(" ")) },
      { title: "Chapter Two", paras: ["The second chapter is short."] },
    ];
    await page.goto("/");
    await importEpub(page, { chapters });
    await enableQwen(page);
    await setQwenDelay(100); // pace generation so it stays ~4x ahead of playback, not 40x
    const base = (await getQwenRequests()).length;
    await page.click(".book");
    await page.click("#rPlay");
    // ~10 sentences generated is ~5 s of scheduled audio against ~1 s played
    await expect.poll(async () => (await getQwenRequests()).length - base, { timeout: 30_000 }).toBeGreaterThanOrEqual(10);
    await setQwenFail(true); // a mid-chapter sentence fails while earlier audio still plays
    await expect(page.locator("#bannerText")).toContainText("Tap play to try again.", { timeout: 20_000 });
    // the promise is made mid-drain — the reading is still running, so the park has not happened
    await expect(page.locator("#rPlay")).toHaveAttribute("aria-label", "Pause");
    await setQwenFail(false); // the server is healthy again: any new request is the app's doing
    const beforeTap = (await getQwenRequests()).length;
    // tap 1 lands on a control labelled "Pause", so it must PAUSE — and it must park
    // (not merely suspend), so the next tap is the retry the banner promises
    await page.click("#rPlay");
    await expect(page.locator("#rPlay")).toHaveAttribute("aria-label", "Play");
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");
    // the audio really stopped — not just the icon
    expect(await page.evaluate(() => document.querySelector("audio") ? document.querySelector("audio").paused : true)).toBe(true);
    await page.waitForTimeout(1500);
    expect((await getQwenRequests()).length - beforeTap).toBe(0); // a pause synthesises nothing
    // tap 2 is the retry
    await page.click("#rPlay");
    await expect.poll(async () => (await getQwenRequests()).length - beforeTap, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(page.locator(".sent.speaking")).toHaveCount(1);
    await expect(page.locator("#rPlay")).toHaveAttribute("aria-label", "Pause"); // it retried
  });

  /* a MIXED pair: the voice was typed beside another concrete host, the key beside no
     address at all (the "" wildcard). One shared boolean made a single foreign stamp
     speak for both, so the cross-host wording claimed the key had been "typed for a
     different server address" — false — and offered "put that other address back",
     which releases only the voice and silently leaves the key held. */
  test("a mixed-provenance pair gets the remedy that is true of BOTH fields", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url); // live, and the address the sheet shows
      localStorage.setItem("lantern.qwenVoice", "cherry");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({
        u: url,
        v: "ethan",                    // held, stamped for another host
        k: "sk-draft",                 // held, stamped for NO address
        bv: "https://other.example",
        bk: "",
      }));
    }, QWEN_URL);
    await page.goto("/");

    // opening the sheet reports whichever hold applies (reportQwenShadow)
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("voice and API key");
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await expect(page.locator("#bannerText")).not.toContainText("different server address");
    await expect(page.locator("#bannerText")).not.toContainText("put that other address back");

    // committing the shown (live) address takes commitQwenUrl's own held branch —
    // same rule there: one foreign stamp must not speak for the wildcard sibling
    await page.fill("#qwenUrl", QWEN_URL);
    await page.locator("#qwenUrl").blur();
    await expect(page.locator("#bannerText")).toContainText("an unfinished edit");
    await expect(page.locator("#bannerText")).not.toContainText("different server address");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("cherry");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-live");

    // and the remedy it names actually releases BOTH — that is why it is the honest one
    await page.fill("#qwenVoice", "ethan");
    await page.locator("#qwenVoice").blur();
    await page.fill("#qwenKey", "sk-draft");
    await page.locator("#qwenKey").blur();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenVoice"))).toBe("ethan");
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenKey"))).toBe("sk-draft");
    await expect(page.locator("#banner")).toBeHidden();
  });

  /* the same rule must not soften a pair that IS wholly cross-host: two foreign
     stamps still get the cross-host wording and its address-revert remedy */
  test("a pair stamped wholly for another host still gets the cross-host wording", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript((url) => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", url);
      localStorage.setItem("lantern.qwenVoice", "cherry");
      localStorage.setItem("lantern.qwenKey", "sk-live");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({
        u: url, v: "ethan", k: "sk-draft",
        bv: "https://other.example", bk: "https://other.example",
      }));
    }, QWEN_URL);
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#bannerText")).toContainText("voice and API key");
    await expect(page.locator("#bannerText")).toContainText("typed for a different server address");
    await expect(page.locator("#bannerText")).toContainText("put that other address back");
  });
});
