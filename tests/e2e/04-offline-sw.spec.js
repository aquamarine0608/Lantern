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

    // go offline BEFORE navigating back to the app: online navigations are
    // network-first and would re-put the real index.html, healing the poison
    // and making this regression test vacuous
    await setAppOffline(true);
    await setCdnOffline(true);

    await page.goto("/#paste");
    await expect(page.locator("#readBtn")).toBeVisible(); // the app, not PNG bytes
  });

  test("a failed CDN import on the first visit shows an actionable error, not a dead page", async ({ page }) => {
    await setCdnOffline(true); // no service worker yet, no HTTP cache: the module import fails outright
    await page.goto("/");
    await expect(page.locator("#bannerText")).toContainText("couldn't finish loading", { timeout: 10_000 });
    await expect(page.locator("#banner")).toBeVisible();
  });

  test("a service worker update carries runtime-cached CDN assets forward", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await warmUp(page);
    // simulate a runtime-cached asset that is NOT in CDN_PRECACHE (onnxruntime's wasm
    // is fetched lazily at model-load time and lands in the CDN cache the same way)
    const WASM = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/ort-wasm.wasm";
    await page.evaluate(async (u) => {
      const name = (await caches.keys()).find((k) => k.startsWith("lantern-cdn-"));
      await (await caches.open(name)).put(u, new Response("wasm-bytes"));
    }, WASM);

    // a VERSION bump must migrate the WHOLE cdn cache, not just the pinned three
    await page.evaluate(() => navigator.serviceWorker.register("/sw.js?v=vNEXT"));
    await page.waitForFunction(async (u) => {
      for (const name of await caches.keys()) {
        if (!name.includes("vNEXT") || !name.includes("cdn")) continue;
        if (await (await caches.open(name)).match(u)) return true;
      }
      return false;
    }, WASM, { timeout: 15_000 });

    // the pinned precache entries came along too
    const hasKokoro = await page.evaluate(async () => {
      const name = (await caches.keys()).find((k) => k.includes("vNEXT") && k.includes("cdn"));
      const keys = (await (await caches.open(name)).keys()).map((r) => r.url);
      return keys.some((u) => u.includes("kokoro.web.js"));
    });
    expect(hasKokoro).toBe(true);
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
