const { test, expect, startRead } = require("../helpers/fixtures");
const { importEpub } = require("../helpers/epub");
const { setAppOffline, setCdnOffline } = require("../helpers/net");

const speakingSi = async (page) => {
  const el = page.locator(".sent.speaking");
  return (await el.count()) ? Number(await el.first().getAttribute("data-si")) : -1;
};

async function openBookReady(page, mockTTS, cfg) {
  await mockTTS(Object.assign({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 }, cfg));
  await page.goto("/");
  await importEpub(page);
  await page.click(".book");
  await expect(page.locator("#viewReader")).toBeVisible();
}

test.describe("reading books aloud", () => {
  test("play highlights sentences as they are spoken and follows along", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.0 });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
    await expect(page.locator("#rIconPause")).toBeVisible();
    await expect(page.locator("#rStatus")).toContainText("of 6");
    // the highlight must move on its own as playback progresses
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("tapping a sentence reads from exactly there", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    await page.click('.sent[data-si="3"]');
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(3);
  });

  test("skip buttons move one sentence at a time", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 }); // long sentences so skips are deterministic
    await page.click('.sent[data-si="2"]');
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(2);
    await page.click("#rNext");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(3);
    await page.click("#rPrev");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(2);
  });

  test("pause and resume", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
    await page.click("#rPlay"); // pause
    await expect(page.locator("#rIconPlay")).toBeVisible();
    const before = await speakingSi(page);
    await page.waitForTimeout(1000);
    expect(await speakingSi(page)).toBe(before); // frozen while paused
    await page.click("#rPlay"); // resume
    await expect(page.locator("#rIconPause")).toBeVisible();
  });

  test("the reading position survives a reload and resumes where you left off", async ({ page, mockTTS }) => {
    // long sentences so the chapter can't finish (and auto-advance) before we pause
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click('.sent[data-si="2"]');
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await page.click("#rPlay"); // pause so the position is stable
    await page.waitForTimeout(400); // let the suspension fully take effect before sampling
    const saved = await speakingSi(page);

    await page.reload();
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator("#rChapter")).toHaveText("Chapter One");
    await expect(page.locator("#rStatus")).toContainText("tap play to resume");
    expect(await speakingSi(page)).toBe(saved); // the resume marker sits on the saved sentence

    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(saved);
  });

  test("chapters advance automatically and keep reading", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    await page.click('.sent[data-si="5"]'); // last sentence of chapter one
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(5);
    await expect(page.locator("#rChapter")).toHaveText("Chapter Two", { timeout: 15_000 });
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
    await expect(page.locator("#rIconPause")).toBeVisible(); // still playing
  });

  test("finishing the last chapter ends the book gracefully", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    await page.click("#tocBtn");
    await page.locator("#tocList button").nth(2).click();
    await expect(page.locator("#rChapter")).toHaveText("Chapter Three");
    await page.click('.sent[data-si="3"]'); // its final sentence
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 15_000 });
    await expect(page.locator("#rIconPlay")).toBeVisible();
    // the routed element must be paused too, or the lock screen keeps a live "playing" transport
    expect(await page.evaluate(() => document.querySelector("audio").paused)).toBe(true);
  });

  test("after the end of the book, play starts reading again instead of wedging", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    await page.click("#tocBtn");
    await page.locator("#tocList button").nth(2).click();
    await page.click('.sent[data-si="3"]');
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 15_000 });

    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    await expect(page.locator("#rIconPause")).toBeVisible();
  });

  test("after the end, skip taps restart cleanly instead of claiming the book is silent", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    await page.click("#tocBtn");
    await page.locator("#tocList button").nth(2).click();
    await page.click('.sent[data-si="3"]');
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 15_000 });

    await page.click("#rNext"); // parked with si out of range — must clamp, not pump an empty run
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    await expect(page.locator("#banner")).toBeHidden(); // never "isn't producing any audio"
  });

  test("a synthesis failure parks the reader for retry instead of skipping the chapter", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { streamFailAfter: 0 }); // every generate() call fails
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("Something went wrong", { timeout: 15_000 });
    await expect(page.locator("#rIconPlay")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#rChapter")).toHaveText("Chapter One"); // must NOT auto-advance

    // recovery: synthesis works again, tap play
    await page.evaluate(() => { window.__TTS_MOCK__.streamFailAfter = -1; });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
  });

  test("skipping back across a chapter boundary re-renders and keeps reading", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click('.sent[data-si="5"]'); // finish chapter one
    await expect(page.locator("#rChapter")).toHaveText("Chapter Two", { timeout: 15_000 });
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
    await page.click("#rPrev"); // back across the boundary (chapter audio cache was dropped)
    await expect(page.locator("#rChapter")).toHaveText("Chapter One", { timeout: 15_000 });
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(5);
  });

  test("an OS-level pause of the audio element pauses the reader engine too", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
    // lock screens and headsets pause the element directly, not through our UI
    await page.evaluate(() => document.querySelector("audio").pause());
    await expect(page.locator("#rIconPlay")).toBeVisible();
    const before = await speakingSi(page);
    await page.waitForTimeout(1200);
    expect(await speakingSi(page)).toBe(before); // the highlight must not advance silently
    await page.click("#rPlay");
    await expect(page.locator("#rIconPause")).toBeVisible();
  });

  test("changing the speed mid-reading keeps playing without errors", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.0 });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    await page.click("#fontBtn");
    await page.click('#rSpeeds button[data-s="1.5"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    await expect(page.locator("#rIconPause")).toBeVisible();
  });

  test("a paste session orphaned during the model download can't kill a book's audio", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 2500, chunkDelay: 50, chunkSeconds: 1.0 });
    await page.goto("/");
    await importEpub(page);
    await page.click("#pasteModeBtn");
    await startRead(page); // parks on the 2.5 s model download
    await expect(page.locator("#readBtn")).toHaveText("Stop reading");
    await page.click("#pasteBackBtn"); // orphan it mid-download
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.click("#rPlay"); // the reader shares the same in-flight model promise
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(1500); // well past the orphan's wake-up
    // the orphan's cleanup must not have detached the reader's audio route
    expect(await page.evaluate(() => !!document.querySelector("audio").srcObject)).toBe(true);
    await expect(page.locator("#rIconPause")).toBeVisible();
  });

  test("books read aloud fully offline after one online visit", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5 });
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(async () => {
      const wanted = ["kokoro.web.js", "fflate"];
      for (const name of await caches.keys()) {
        const keys = await (await caches.open(name)).keys();
        for (const w of wanted) if (keys.some((k) => k.url.includes(w))) wanted.splice(wanted.indexOf(w), 1);
      }
      return wanted.length === 0;
    });
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);

    await setAppOffline(true);
    await setCdnOffline(true);
    try {
      await page.reload();
      await expect(page.locator(".book .b-title")).toHaveText("The Test Book"); // shelf from IndexedDB
      await page.click(".book");
      await expect(page.locator("#viewReader")).toBeVisible();
      await page.click("#rPlay");
      await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
    } finally {
      await setAppOffline(false);
      await setCdnOffline(false);
    }
  });
});
