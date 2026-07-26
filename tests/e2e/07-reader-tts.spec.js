const { test, expect, startRead } = require("../helpers/fixtures");
const { importEpub, makeEpub } = require("../helpers/epub");
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
    // the status line keeps the guidance even after the banner is later cleared
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");

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

  test("leaving the reader releases the lock-screen transport completely", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.0 });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    await page.click("#backBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible();
    // a dead transport on the lock screen (title + live buttons for a closed book) is the regression
    const ms = await page.evaluate(() => ({
      state: navigator.mediaSession.playbackState,
      hasMeta: navigator.mediaSession.metadata !== null,
    }));
    expect(ms.state).toBe("none");
    expect(ms.hasMeta).toBe(false);
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

  test("an orphaned generation from one book can never inject its audio into another book", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 2500, chunkSeconds: 0.5 });
    await page.goto("/");
    await importEpub(page); // "The Test Book"
    await page.setInputFiles("#bookFile", {
      name: "bravo.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Bravo Book", chapters: [{ title: "Bravo Chapter", paras: ["Bravo sentence one. Bravo sentence two."] }] }),
    });
    await expect(page.locator(".book")).toHaveCount(2);
    await page.locator(".book", { hasText: "The Test Book" }).click();
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.click("#rPlay"); // kokoro generate() for its sentence 0 is now in flight for 2.5 s
    await page.waitForTimeout(400);
    await page.click("#backBtn"); // orphan it — generate() can't be aborted mid-flight
    await page.locator(".book", { hasText: "Bravo Book" }).click();
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.evaluate(() => { window.__TTS_MOCK__.chunkDelay = 50; });
    await page.waitForTimeout(2600); // the orphan resolves AFTER Bravo's fresh cache was cleared
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    // Bravo's first sentence must have been synthesized for real: a cross-book cache
    // hit would silently play the other book's audio and never call generate for it
    const texts = await page.evaluate(() => window.__TTS_GEN_TEXTS || []);
    expect(texts.some((t) => t.includes("Bravo Chapter"))).toBe(true);
  });

  test("while the engine warms up, the reader shows the busy pulse and an honest status", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { loadDelay: 3000 });
    await page.click("#rPlay");
    // during the 3 s model load: pulsing button, truthful status — not "tap play to listen"
    await expect(page.locator("#rPlay")).toHaveClass(/working/);
    await expect(page.locator("#rStatus")).toContainText("generating on-device");
    await expect(page.locator("#rStatus")).not.toContainText("tap play");
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
    await expect(page.locator("#rPlay")).not.toHaveClass(/working/);
  });

  test("pausing after the chapter's audio has drained parks cleanly instead of wedging", async ({ page, mockTTS }) => {
    // one real sentence (0.4 s of audio) + a trailing sentence that synthesizes to
    // nothing: the last buffer drains long before the generation loop exits, and the
    // pause suspends the context in exactly that window
    await mockTTS({ loadDelay: 20, chunkDelay: 2000, chunkSeconds: 0.4, emptyChunkAt: 1 });
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "solo.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Solo", chapters: [{ title: "Solo Chapter", paras: ["Only sentence here."] }] }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0); // highlight appears at pump start (~0.3 s)
    // timeline: sentence 0 generates 0→2 s, its 0.4 s of audio ends ~2.5 s, and the
    // empty sentence 1 generates 2→4 s. Pause at ~3.2 s: audio drained, loop still running.
    await page.waitForTimeout(2900);
    await page.click("#rPlay"); // pause with nothing scheduled
    await page.waitForTimeout(1800); // the generation loop exits while the context is suspended
    // the reader must park restartably — not freeze with a dead transport
    await expect(page.locator("#rIconPlay")).toBeVisible();
    await expect(page.locator("#rStatus")).toContainText("tap play to continue");
    // resume: a NEW run replays the chapter (from cache) and finishes the book —
    // the pre-fix wedge resumed an empty context and froze here forever
    await page.click("#rPlay");
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 15_000 });
    await expect(page.locator("#rIconPlay")).toBeVisible();
    expect(await page.evaluate(() => document.querySelector("audio").paused)).toBe(true);
  });

  test("skips during the engine warm-up act on the tapped sentence, not the previous position", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { loadDelay: 2500 });
    await page.click('.sent[data-si="2"]'); // readerPlayFrom(2) parks on the model load
    await page.click("#rNext"); // must step 2 → 3, not from a stale previous position
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBe(3);
  });

  test("selecting text inside a sentence never starts playback", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    const box = await page.locator('.sent[data-si="1"]').boundingBox();
    await page.mouse.move(box.x + 5, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(120, box.width - 10), box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    // copying a phrase must not start audio, publish a transport, or trigger the model
    await expect(page.locator("#rIconPlay")).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll(".sent.speaking").length)).toBe(0);
    expect(await page.evaluate(() => window.__TTS_GEN || 0)).toBe(0);
    // and a plain tap still reads
    await page.click('.sent[data-si="1"]');
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(1);
  });

  test("reopening a finished book keeps its 100% progress", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "single.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "One Chapter", chapters: [{ title: "Only", paras: ["First line here. Second line here."] }] }),
    });
    await page.click(".book");
    await page.click('.sent[data-si="2"]'); // last sentence — finishes the book
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 15_000 });
    await page.click("#backBtn");
    // renderLibrary is async — poll until the re-rendered shelf shows the bar
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".b-progress i").style.width), { timeout: 5_000 })
      .toBe("100%");

    // merely reopening must not demote the end-of-book sentinel to length-1
    await page.click(".book");
    await expect(page.locator("#rStatus")).toContainText("the end");
    await page.click("#backBtn");
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".b-progress i").style.width), { timeout: 5_000 })
      .toBe("100%");

    // and play on the reopened finished book restarts from the top
    await page.click(".book");
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBe(0);
  });

  test("double-clicking a word stops the run the first click started", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.locator('.sent[data-si="1"]').dblclick();
    await page.waitForTimeout(500);
    // the look-up gesture must leave the reader parked where it was, not playing
    await expect(page.locator("#rIconPlay")).toBeVisible();
    await expect(page.locator("#rStatus")).toContainText("tap play to resume");
    expect(await page.evaluate(() => document.querySelector("audio").paused)).toBe(true);
  });

  test("tapping a sentence never scrolls the tapped text out from under the pointer", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 400, chunkSeconds: 1.0 });
    const endless = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(35).trim();
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "endless.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Endless", chapters: [{ title: "Run-on", paras: [endless] }] }),
    });
    await page.click(".book");
    await expect(page.locator(".sent").first()).toBeVisible();
    // pick a POINT on the lowest visible line: element-based clicking auto-scrolls
    // multi-line spans into view, which is exactly the movement this test forbids
    const pt = await page.evaluate(() => {
      const box = document.getElementById("rScroll").getBoundingClientRect();
      let best = null;
      for (const el of document.querySelectorAll(".sent")) {
        const r = el.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        if (mid > box.top + 10 && mid < box.bottom - 10) best = { x: r.left + Math.min(40, r.width / 2), y: mid };
      }
      return best;
    });
    const before = await page.evaluate(() => document.getElementById("rScroll").scrollTop);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => document.getElementById("rScroll").scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2); // press 2 of a double-click must land on the same text
  });

  test("double-clicking a word in a finished book keeps 'the end' and its 100%", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "single2.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "One More", chapters: [{ title: "Alone", paras: ["First line here. Second line here."] }] }),
    });
    await page.click(".book");
    await page.click('.sent[data-si="2"]');
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 15_000 });
    await page.locator('.sent[data-si="1"]').dblclick(); // look up a word after finishing
    await page.waitForTimeout(400);
    await expect(page.locator("#rStatus")).toContainText("the end"); // not "tap play to resume"
    await expect(page.locator(".sent.speaking")).toHaveAttribute("data-si", "2"); // marker on the last real sentence
    await page.click("#backBtn");
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".b-progress i").style.width), { timeout: 5_000 })
      .toBe("100%"); // the sentinel survived the round trip
  });

  test("the silent-switch hint is present from book open and clears on teardown", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS);
    // shown at open, NOT at first play: un-hiding it mid-gesture would resize the
    // scroller between the two presses of a double-click
    await expect(page.locator("#readerHint")).toBeVisible();
    await page.click("#backBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible(); // hashchange → teardown is async
    expect(await page.evaluate(() => document.getElementById("readerHint").hidden)).toBe(true);
  });

  test("tapping an already-cached sentence never scrolls on the follow-along's first tick", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.8 });
    const endless = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(35).trim();
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "endless2.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Endless Two", chapters: [{ title: "Run-on", paras: [endless] }] }),
    });
    await page.click(".book");
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
    await page.click("#rPlay"); // pause — sentences 0..N are now all in rd.cache
    await page.waitForTimeout(300);
    await page.locator('.sent[data-si="1"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => document.getElementById("rScroll").scrollTop);
    await page.click('.sent[data-si="1"]'); // pure cache hit: audio schedules ~100 ms later
    await page.waitForTimeout(400); // past the follow-along's first tick, before sentence 2
    const after = await page.evaluate(() => document.getElementById("rScroll").scrollTop);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2); // the first tick must hold, not re-centre
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
