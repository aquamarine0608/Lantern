const { test, expect, startRead } = require("../helpers/fixtures");
const { importEpub, makeEpub } = require("../helpers/epub");
const { setAppOffline, setCdnOffline } = require("../helpers/net");

const speakingSi = async (page) => {
  const el = page.locator(".sent.speaking");
  return (await el.count()) ? Number(await el.first().getAttribute("data-si")) : -1;
};

/* Records every sentence the highlight lands on, in order. Polling for a single
   value can't tell "the tap moved us here" from "playback drifted here a second
   and a half later", which is exactly the distinction the skip-direction specs
   below need. */
const recordSpeaking = (page) =>
  page.evaluate(() => {
    clearInterval(window.__seenTimer);
    window.__seen = [];
    window.__seenTimer = setInterval(() => {
      const el = document.querySelector(".sent.speaking");
      const si = el ? Number(el.dataset.si) : -1;
      if (si >= 0 && window.__seen[window.__seen.length - 1] !== si) window.__seen.push(si);
    }, 20);
  });
const seen = (page) => page.evaluate(() => window.__seen);
const seenCount = (page) => page.evaluate(() => window.__seen.length);

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

  /* Previous/Next are the ONLY keyboard/assistive-tech path to sentence navigation
     (the sentence spans are pointer-only by design), so a parked reader must still
     honour the direction of the tap instead of collapsing both buttons into
     "play the sentence you are already on". */
  test("the skip buttons honour their direction while the reader is parked", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    // a freshly opened book parks on sentence one: Next must MOVE to sentence two
    await expect(page.locator("#rStatus")).toContainText("tap play to listen");
    await recordSpeaking(page);
    await page.click("#rNext");
    await expect.poll(() => seenCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
    expect((await seen(page))[0]).toBe(1); // the FIRST sentence spoken, not one it drifts into

    // reopened at a saved position ("tap play to resume"): Previous must step BACK
    await page.click('.sent[data-si="2"]'); // long sentences: the chapter can't finish before we pause
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    await page.click("#rPlay"); // pause so the saved position is stable
    await page.waitForTimeout(400);
    const saved = await speakingSi(page);
    await page.reload();
    await expect(page.locator("#rStatus")).toContainText("tap play to resume");
    expect(await speakingSi(page)).toBe(saved);
    await recordSpeaking(page); // [0] is the parked resume marker
    await page.click("#rPrev");
    await expect.poll(() => seenCount(page), { timeout: 15_000 }).toBeGreaterThan(1);
    expect((await seen(page))[1]).toBe(saved - 1); // moved back, not forward off the parked sentence
  });

  test('Previous at "the end" replays the last sentence instead of restarting the chapter', async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click("#tocBtn");
    await page.locator("#tocList button").nth(2).click();
    await expect(page.locator("#rChapter")).toHaveText("Chapter Three");
    const last = (await page.locator(".sent").count()) - 1;
    await page.click(`.sent[data-si="${last}"]`);
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 20_000 });

    // the sentinel parks si one PAST the last sentence — Previous steps back onto it.
    // It must NOT fall through to the Next behaviour of restarting at sentence one.
    await recordSpeaking(page);
    await page.click("#rPrev");
    await expect(page.locator("#rStatus")).not.toContainText("the end", { timeout: 15_000 });
    await expect(page.locator("#rStatus")).toContainText("the end", { timeout: 20_000 }); // the replay finished
    expect(await seen(page)).toEqual([last]); // the highlight never left the last sentence
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

  /* The park this banner reports leaves rd.started false, so readerSettingsChanged
     early-returns and the voice change itself is the ONLY thing that can take the
     banner down — without setVoice's clearErrorBanner the message survives the very
     action it names as the remedy, fixed over the top of the chapter and floated
     above the settings sheet the user picked the new voice in. */
  test("changing the voice clears the failure banner whose remedy it is", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkDelay: 30, chunkSeconds: 0 }); // every chunk comes back empty
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("isn't producing any audio", { timeout: 20_000 });
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");

    await page.click("#fontBtn");
    const live = await page.locator("#rVoice").inputValue();
    // the changed-value guard: re-picking the voice already reading answers nothing
    await page.selectOption("#rVoice", live);
    await expect(page.locator("#banner")).toBeVisible();

    const other = await page.locator("#rVoice option").nth(3).getAttribute("value");
    expect(other).not.toBe(live);
    await page.selectOption("#rVoice", other);
    await expect(page.locator("#banner")).toBeHidden();
    // ...and the parked reader stays parked: no silent restart behind the open sheet
    await expect(page.locator("#rStatus")).toContainText("tap play to retry");
    await expect(page.locator("#rIconPlay")).toBeVisible();
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

  test("chapter auto-advance updates an open Chapters sheet in place, keeping focus", async ({ page, mockTTS }) => {
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click('.sent[data-si="5"]'); // last sentence of chapter one — will auto-advance
    await page.click("#tocBtn");
    await page.locator("#tocList button").nth(2).focus(); // browsing the list mid-listen
    await expect(page.locator("#rChapter")).toHaveText("Chapter Two", { timeout: 15_000 });
    // the list was updated in place: the focused button survived, the marker moved
    expect(await page.evaluate(() => document.activeElement.textContent)).toContain("Chapter Three");
    await expect(page.locator("#tocList button").nth(1)).toHaveClass(/current/);
    await expect(page.locator("#tocList button").nth(1)).toHaveAttribute("aria-current", "true");
    expect(await page.evaluate(() => document.querySelectorAll('#tocList [aria-current]').length)).toBe(1);
    await page.keyboard.press("Escape");
  });

  test("neither the status line nor the download banner resizes the reading pane mid-gesture", async ({ page, mockTTS }) => {
    // first run: the tap starts the model download, which raises the banner — and
    // the status line gains the engine label. Neither may move #rScroll's edges.
    await mockTTS({ loadDelay: 1500, progressSteps: 1, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await expect(page.locator(".sent").first()).toBeVisible();
    const rect0 = await page.evaluate(() => {
      const r = document.getElementById("rScroll").getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    await page.click('.sent[data-si="1"]');
    await expect(page.locator("#banner")).toBeVisible();
    const rect1 = await page.evaluate(() => {
      const r = document.getElementById("rScroll").getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    expect(rect1.top).toBe(rect0.top);
    expect(rect1.bottom).toBe(rect0.bottom); // press 2 of a double-click lands on the same text
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

  test("a pause tapped during the reader's audio activation sticks through the warm-up", async ({ page, mockTTS }) => {
    // activation is a REAL await on iOS: the context runs immediately, the promise
    // resolves late — our own play() after it must not discard a pause tapped inside
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
    await openBookReady(page, mockTTS, { loadDelay: 3000 });
    await page.click("#rPlay"); // start — the busy warm-up begins
    await page.waitForFunction(() => window.__lastCtx && window.__lastCtx.state === "running");
    await page.click("#rPlay"); // pause while the activation promise is still pending
    await page.waitForTimeout(900); // activation resolves in here — it must NOT play the element
    expect(await page.evaluate(() => window.__lastCtx.state)).toBe("suspended");
    // …and once the engine finishes loading, the pause still stands
    await page.waitForTimeout(2800);
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");
    await expect(page.locator("#rIconPlay")).toBeVisible();
    expect(await page.evaluate(() => window.__lastCtx.state)).toBe("suspended");
    // resuming picks up THIS run's stream — the highlight starts moving again
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("a settings change parked during an interrupted warm-up settles the play button", async ({ page, mockTTS }) => {
    await page.addInitScript(() => {
      const OrigAC = window.AudioContext;
      window.AudioContext = class extends OrigAC {
        constructor(...a) { super(...a); window.__lastCtx = this; }
      };
    });
    await openBookReady(page, mockTTS, { loadDelay: 3000 });
    await page.click("#rPlay"); // busy warm-up begins
    await page.waitForFunction(() => window.__lastCtx && window.__lastCtx.state === "running");
    // an OS interruption suspends the context mid-warm-up: rd.playing goes false,
    // but the icon deliberately stays "busy" until the warm-up settles
    await page.evaluate(() => window.__lastCtx.suspend());
    await page.waitForFunction(() => window.__lastCtx.state === "suspended");
    // a settings change now parks the run — the park must settle the icon too,
    // not leave a pulsing "Pause" button on a reader that says "tap play"
    await page.click("#fontBtn");
    await page.click('#rSpeeds button[data-s="1.2"]');
    await page.click(".sheet:not([hidden]) .sheet-done");
    await expect(page.locator("#rPlay")).toHaveAttribute("aria-label", "Play");
    await expect(page.locator("#rPlay")).not.toHaveClass(/working/);
    await expect(page.locator("#rStatus")).toContainText("tap play to resume");
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("paused");
    // and the settled button actually starts playback again
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
  });

  /* the reader's own ctx.onstatechange had the same gap as the paste view's: it
     settled the icon on an OS interruption but left the OS transport claiming
     "playing" for a silent reader. The busy warm-up branch stays deliberately
     untouched — setReaderMediaSession settles that once the engine is ready. */
  test("an interrupted reader context pauses the lock-screen transport, with no user tap", async ({ page, mockTTS }) => {
    await page.addInitScript(() => {
      const OrigAC = window.AudioContext;
      window.AudioContext = class extends OrigAC {
        constructor(...a) { super(...a); window.__lastCtx = this; }
      };
    });
    await openBookReady(page, mockTTS, { chunkSeconds: 1.5 });
    await page.click("#rPlay");
    await expect.poll(() => speakingSi(page), { timeout: 20_000 }).toBe(0); // warm-up over
    const state = () => page.evaluate(() => navigator.mediaSession.playbackState);
    await expect.poll(state, { timeout: 10_000 }).toBe("playing");

    await page.evaluate(() => window.__lastCtx.suspend());
    await expect.poll(state, { timeout: 5_000 }).toBe("paused");
    await expect(page.locator("#rIconPlay")).toBeVisible();

    await page.evaluate(() => window.__lastCtx.resume());
    await expect.poll(state, { timeout: 5_000 }).toBe("playing");
    await expect(page.locator("#rIconPause")).toBeVisible();
  });

  /* the forward chapter advance and the TOC jump both persist the new chapter
     synchronously, before any playback. The BACKWARD skip did not — and readerPlayFrom
     only writes later, via syncFromClock, once audio actually starts. Park it on a
     stalled engine and the position never reached storage at all. */
  test("skipping back into the previous chapter saves the position before any audio", async ({ page, mockTTS }) => {
    await page.addInitScript(() => {
      // a force-quit has no pagehide: once armed, no further progress write lands
      const origPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (window.__freezeProgress && this.name === "progress") return undefined;
        return origPut.apply(this, args);
      };
    });
    await mockTTS({ loadDelay: 30_000, chunkDelay: 50, chunkSeconds: 0.5 }); // the engine never arrives
    await page.goto("/");
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);

    // park the reader at chapter 2, sentence 0 — the exact state where a Previous
    // tap has to cross the chapter boundary
    const id = await page.locator(".book").getAttribute("data-id");
    await page.evaluate(async (bookId) => {
      await new Promise((resolve, reject) => {
        const open = indexedDB.open("lantern-books", 1);
        open.onsuccess = () => {
          const tx = open.result.transaction("progress", "readwrite");
          tx.objectStore("progress").put({ bookId, ch: 1, si: 0, pct: 0.4, updatedAt: Date.now() });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    }, id);

    await page.click(".book");
    await expect(page.locator("#rChapter")).toHaveText("Chapter Two");
    await expect(page.locator("#rStatus")).toContainText("tap play to resume");

    await page.click("#rPrev"); // crosses back into chapter 1 and parks on the warm-up
    await expect(page.locator("#rChapter")).toHaveText("Chapter One");
    await expect(page.locator("#rStatus")).toContainText("sentence 6 of 6");

    // the row must already say chapter 1's last sentence — no audio will ever play
    const row = async () =>
      page.evaluate(
        (bookId) =>
          new Promise((resolve) => {
            const open = indexedDB.open("lantern-books", 1);
            open.onsuccess = () => {
              const req = open.result.transaction("progress", "readonly").objectStore("progress").get(bookId);
              req.onsuccess = () => resolve(req.result ? { ch: req.result.ch, si: req.result.si } : null);
            };
          }),
        id
      );
    await expect.poll(row, { timeout: 5_000 }).toEqual({ ch: 0, si: 5 });

    // and a force-quit resumes there, not at the chapter the user skipped out of
    await page.evaluate(() => { window.__freezeProgress = true; });
    await page.reload();
    await expect(page.locator("#rChapter")).toHaveText("Chapter One");
    await expect(page.locator("#rStatus")).toContainText("tap play to resume");
    expect(await speakingSi(page)).toBe(5);
  });

  /* showView early-returns on activeView === name, so its "an error must not follow
     the user into another view" clear never ran on a reader→reader hop — and
     readerTeardown does not clear banners either. "This book isn't producing any
     audio" then stood, position:fixed, over a book that had failed nothing. */
  test("a reader failure banner does not follow you into the next book", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.5, streamFailAfter: 0 });
    await page.goto("/");
    await importEpub(page, { title: "Book A" });
    await expect(page.locator(".book")).toHaveCount(1);
    await importEpub(page, { title: "Book B" });
    await expect(page.locator(".book")).toHaveCount(2);
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll(".book")].map((c) => ({ id: c.dataset.id, title: c.querySelector(".b-title").textContent }))
    );
    const bookB = cards.find((c) => c.title === "Book B");
    const bookA = cards.find((c) => c.title === "Book A");

    await page.click(`.book[data-id="${bookA.id}"] .book-open`);
    await expect(page.locator("#rBook")).toHaveText("Book A");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("Tap play to try again", { timeout: 20_000 });
    await expect(page.locator("#banner")).toBeVisible();

    // a direct #read/ → #read/ hop, exactly what a multi-entry history traversal does
    await page.evaluate((bid) => { location.hash = "#read/" + encodeURIComponent(bid); }, bookB.id);
    await expect(page.locator("#rBook")).toHaveText("Book B");
    await expect(page.locator("#banner")).toBeHidden();
    await expect(page.locator("#rStatus")).toContainText("Chapter 1 of 3");
  });
});
