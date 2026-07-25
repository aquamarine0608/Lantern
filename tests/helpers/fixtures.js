const base = require("@playwright/test");

/* Every test gets:
   - pageErrors: uncaught exceptions / unhandled rejections collected from the
     page; asserted empty automatically at the end of every test (the app must
     never throw uncaught).
   - AudioContext instrumentation (window.__CTXS) to detect leaked contexts —
     iOS caps live AudioContexts, so every context the app creates must end up
     closed unless it is the one actively playing.
   - mockTTS(cfg): configure the fake Kokoro engine before page load. */

const test = base.test.extend({
  pageErrors: [
    async ({ page }, use) => {
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      await use(errors);
      base.expect(errors, "the page must never throw uncaught errors").toEqual([]);
    },
    { auto: true },
  ],

  instrumentAudio: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        const Real = window.AudioContext || window.webkitAudioContext;
        window.__CTXS = [];
        window.AudioContext = class extends Real {
          constructor(...a) {
            super(...a);
            window.__CTXS.push(this);
          }
        };
      });
      await use();
    },
    { auto: true },
  ],

  mockTTS: async ({ page }, use) => {
    await use(async (cfg) => {
      await page.addInitScript((c) => {
        window.__TTS_MOCK__ = c;
      }, cfg);
    });
  },
});

const SAMPLE_TEXT = "The lantern glows warmly tonight. A quiet voice reads every word. The story carries on until morning.";
const SENTENCES = 3;

async function startRead(page, text = SAMPLE_TEXT) {
  await page.fill("#text", text);
  await page.click("#readBtn");
}

async function waitForFileMode(page, timeout = 30_000) {
  await test.expect(page.locator("#statusLine")).toContainText("tap the wave", { timeout });
}

module.exports = { test, expect: base.expect, SAMPLE_TEXT, SENTENCES, startRead, waitForFileMode };
