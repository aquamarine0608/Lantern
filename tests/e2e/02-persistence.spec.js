const { test, expect, startRead, waitForFileMode } = require("../helpers/fixtures");

test.describe("persistence across refreshes", () => {
  test("text, voice and speed survive a reload", async ({ page }) => {
    await page.goto("/#paste");
    await page.fill("#text", "Remember me after the refresh.");
    await page.selectOption("#voice", "bm_fable");
    await page.click('#speeds button[data-s="1.5"]');
    await page.waitForTimeout(600); // text save is debounced at 400 ms

    await page.reload();
    await expect(page.locator("#text")).toHaveValue("Remember me after the refresh.");
    await expect(page.locator("#count")).toHaveText("5 words");
    await expect(page.locator("#voice")).toHaveValue("bm_fable");
    await expect(page.locator('#speeds button[data-s="1.5"]')).toHaveClass(/on/);
  });

  test("text typed right before a refresh is not lost", async ({ page }) => {
    await page.goto("/#paste");
    await page.fill("#text", "Typed and instantly refreshed.");
    // reload immediately — well inside the 400 ms debounce window
    await page.reload();
    await expect(page.locator("#text")).toHaveValue("Typed and instantly refreshed.");
  });

  test("an invalid stored speed falls back to a real speed button", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lantern.speed", "0.9"));
    await page.goto("/#paste");
    await expect(page.locator("#speeds button.on")).toHaveCount(1);
  });

  test("an unknown stored voice falls back to a valid option and reading still works", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript(() => localStorage.setItem("lantern.voice", "zz_removed_voice"));
    await page.goto("/#paste");
    const value = await page.locator("#voice").inputValue();
    expect(value).not.toBe(""); // must not be left with no selection
    await startRead(page);
    await waitForFileMode(page);
  });

  test("once downloaded, the model warms up by itself on the next visit", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await startRead(page);
    await waitForFileMode(page);

    await page.reload();
    // no interaction: the model must load on its own, without the first-run banner
    await expect(page.locator("#modelStateText")).toHaveText("voice model ready", { timeout: 10_000 });
    await expect(page.locator("#banner")).toBeHidden();
    await startRead(page);
    await waitForFileMode(page);
  });

  test("without the Cache API the app never claims the model is saved on the device", async ({ page, mockTTS }) => {
    // plain-HTTP LAN origins have no window.caches: the model cannot persist there,
    // so "stored on this device / one time only" would be a lie and the modelReady
    // flag would fake an instant warm load that is actually a full re-download
    // progressSteps: 1 keeps the progress callback from overwriting the banner until 1.5 s in
    await mockTTS({ loadDelay: 1500, progressSteps: 1, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.addInitScript(() => {
      delete Window.prototype.caches;
      try { delete window.caches; } catch {}
    });
    await page.goto("/#paste");
    await startRead(page);
    await expect(page.locator("#bannerText")).toContainText("isn't HTTPS", { timeout: 10_000 });
    await waitForFileMode(page);
    const flag = await page.evaluate(() => localStorage.getItem("lantern.modelReady"));
    expect(flag).toBeNull();
  });

  test("reload mid-generation comes back to a clean idle page with the text intact", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 400, chunkSeconds: 0.5 });
    await page.goto("/#paste");
    await page.fill("#text", "One long sentence here. Another one follows. And a third for good measure. Then a fourth.");
    await page.waitForTimeout(600);
    await page.click("#readBtn");
    await expect(page.locator("#statusLine")).toContainText(/sentence/, { timeout: 15_000 });

    await page.reload();
    await expect(page.locator("#readBtn")).toHaveText("Read aloud");
    await expect(page.locator("#player")).toBeHidden();
    await expect(page.locator("#text")).toHaveValue(/One long sentence here/);
    // and the app is still fully usable
    await page.click("#readBtn");
    await waitForFileMode(page);
  });
});
