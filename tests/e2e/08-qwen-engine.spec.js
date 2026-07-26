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
});
