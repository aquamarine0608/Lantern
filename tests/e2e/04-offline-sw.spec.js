const { test, expect, startRead, waitForFileMode } = require("../helpers/fixtures");
const { setAppOffline, setCdnOffline } = require("../helpers/net");

/* True offline testing: the local app server and the mock CDN server destroy
   every socket while "offline", which also applies to fetches issued by the
   service worker (browser-level offline emulation does not). */

async function warmUp(page, path = "/#paste") {
  await page.goto(path);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  // a controlled reload routes the CDN module through the SW so it lands in the CDN cache
  await page.reload();
  await page.waitForFunction(async () => {
    for (const name of await caches.keys()) {
      const keys = await (await caches.open(name)).keys();
      if (keys.some((k) => k.url.includes("kokoro.web.js"))) return true;
    }
    return false;
  });
}

test.describe("service worker and offline", () => {
  test.afterEach(async () => {
    await setAppOffline(false);
    await setCdnOffline(false);
  });

  test("after one visit the app fully works offline, including reading aloud", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await warmUp(page);

    await setAppOffline(true);
    await setCdnOffline(true);

    await page.reload();
    await expect(page.locator("#readBtn")).toBeVisible();
    await expect(page.locator("#count")).toBeVisible();
    await startRead(page);
    await waitForFileMode(page);
    await expect(page.locator("#modelStateText")).toHaveText("voice model ready");
  });

  test("offline works even after only the very first visit — no second load required", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await page.evaluate(() => navigator.serviceWorker.ready);
    // the install-time precache must cover the CDN module without any reload
    await page.waitForFunction(async () => {
      for (const name of await caches.keys()) {
        const keys = await (await caches.open(name)).keys();
        if (keys.some((k) => k.url.includes("kokoro.web.js"))) return true;
      }
      return false;
    });

    await setAppOffline(true);
    await setCdnOffline(true);

    await page.reload();
    await startRead(page);
    await waitForFileMode(page);
  });

  test("offline navigation with a query string is still served from the cache", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await warmUp(page);

    await setAppOffline(true);
    await setCdnOffline(true);

    // installed PWAs and shared links often carry query params
    await page.goto("/?source=homescreen");
    await expect(page.locator("#addBookBtn")).toBeVisible();
  });

  test("navigating to a sibling file never poisons the offline shell", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await warmUp(page);
    // a top-level navigation to an in-scope asset must not be cached AS the app shell
    await page.goto("/icon-180.png");
    await page.goto("/#paste");

    await setAppOffline(true);
    await setCdnOffline(true);
    await page.reload();
    await expect(page.locator("#readBtn")).toBeVisible(); // the app, not PNG bytes
  });

  test("a failed CDN import on the first visit shows an actionable error, not a dead page", async ({ page }) => {
    await setCdnOffline(true); // no service worker yet, no HTTP cache: the module import fails outright
    await page.goto("/");
    await expect(page.locator("#bannerText")).toContainText("couldn't finish loading", { timeout: 10_000 });
    await expect(page.locator("#banner")).toBeVisible();
  });

  test("the Google Fonts stylesheet is cached for offline use", async ({ page }) => {
    await warmUp(page);
    const fontsCached = await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        const keys = await (await caches.open(name)).keys();
        if (keys.some((k) => k.url.includes("fonts.googleapis.com"))) return true;
      }
      return false;
    });
    expect(fontsCached).toBe(true);
  });
});
