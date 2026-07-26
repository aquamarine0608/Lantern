const { test, expect } = require("../helpers/fixtures");
const { importEpub } = require("../helpers/epub");

test.describe("accessibility and input", () => {
  test("a book can be opened with the keyboard alone", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    // the open affordance is a real button, not a click handler on a div
    await page.locator(".book-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#viewReader")).toBeVisible();
    // and the destructive Remove stays a separate, individually focusable control
    await page.click("#backBtn");
    await expect(page.locator(".book .b-del")).toHaveText("Remove");
  });

  test("pinch-zoom is not disabled", async ({ page }) => {
    await page.goto("/");
    const content = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(content).not.toContain("user-scalable");
    expect(content).not.toContain("maximum-scale");
  });

  test("errors reach assistive tech through the alert live region", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "broken.epub", mimeType: "application/epub+zip",
      buffer: Buffer.from("definitely not a zip"),
    });
    await expect(page.locator("#bannerText")).toContainText("Couldn't open that EPUB");
    await expect
      .poll(() => page.evaluate(() => document.getElementById("a11yAlert").textContent), { timeout: 5_000 })
      .toContain("Couldn't open that EPUB");
    // a good import clears the banner AND silences the stale announcement
    await importEpub(page);
    await expect(page.locator("#banner")).toBeHidden();
    expect(await page.evaluate(() => document.getElementById("a11yAlert").textContent)).toBe("");
  });

  test("sheets are real modals: focus moves in, the app inerts, Escape closes, focus returns", async ({ page }) => {
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#setSheet")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement.id)).toBe("setSheet");
    expect(await page.evaluate(() => document.getElementById("viewLibrary").inert)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#setSheet")).toBeHidden();
    expect(await page.evaluate(() => document.getElementById("viewLibrary").inert)).toBe(false);
    expect(await page.evaluate(() => document.activeElement.id)).toBe("libVoiceBtn");
  });

  test("speed and engine selection is exposed as aria-pressed state", async ({ page }) => {
    await page.goto("/#paste");
    await expect(page.locator('#speeds button[data-s="1"]')).toHaveAttribute("aria-pressed", "true");
    await page.click('#speeds button[data-s="1.5"]');
    await expect(page.locator('#speeds button[data-s="1.5"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('#speeds button[data-s="1"]')).toHaveAttribute("aria-pressed", "false");
  });

  test("keyboard focus on the segmented buttons draws inside the clipping pill", async ({ page }) => {
    await page.goto("/#paste");
    // .speeds is overflow:hidden — an outward ring is fully clipped, so the rule
    // must draw the ring inside the button (verified by pixel-diff in review; the
    // stylesheet pin keeps the fix from being silently reverted)
    const ok = await page.evaluate(() => {
      for (const s of document.styleSheets) {
        let rules;
        try { rules = s.cssRules; } catch { continue; } // the fonts stylesheet is cross-origin
        for (const r of rules)
          if (r.selectorText === ".speeds button:focus-visible" && r.style.outlineOffset === "-3px") return true;
      }
      return false;
    });
    expect(ok).toBe(true);
    const sel16 = await page.locator("#voice").evaluate((el) => getComputedStyle(el).fontSize);
    expect(sel16).toBe("16px"); // sub-16px form controls re-trigger iOS focus auto-zoom
  });

  test("an error and the park status are both announced — neither clobbers the other", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await page.click("#fontBtn");
    await page.click('#engineBtns button[data-e="qwen"]'); // no server URL entered
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#rPlay");
    await expect(page.locator("#bannerText")).toContainText("Set your Qwen3-TTS server first");
    await expect
      .poll(() => page.evaluate(() => document.getElementById("a11yAlert").textContent), { timeout: 5_000 })
      .toContain("Qwen3-TTS server");
    const announced = await page.evaluate(() => document.getElementById("a11yAlert").textContent);
    expect(announced).toContain("tap play to retry"); // the park line coalesces with the error
  });

  test("the whole book card opens the book — including the padding ring", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    const box = await page.locator(".book").boundingBox();
    await page.mouse.click(box.x + 3, box.y + box.height / 2); // inside the 10px padding ring
    await expect(page.locator("#viewReader")).toBeVisible();
    // and Remove still works above the stretched hit area
    await page.click("#backBtn");
    await page.click(".book .b-del");
    await expect(page.locator(".book .b-del")).toHaveText("Really remove?");
  });

  test("the server config fields carry programmatic labels, not placeholder names", async ({ page }) => {
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.click('#engineBtns button[data-e="qwen"]');
    const cfg = page.locator("#qwenCfg");
    await expect(cfg.getByLabel("Server")).toHaveAttribute("id", "qwenUrl");
    await expect(cfg.getByLabel("Voice", { exact: true })).toHaveAttribute("id", "qwenVoice");
    await expect(cfg.getByLabel("API key")).toHaveAttribute("id", "qwenKey"); // was announced as "optional"
  });

  test("the settings-sheet speed and engine buttons keep a real touch height", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.click("#fontBtn");
    const speedH = await page.locator("#rSpeeds button").first().evaluate((el) => el.getBoundingClientRect().height);
    const engineH = await page.locator("#engineBtns button").first().evaluate((el) => el.getBoundingClientRect().height);
    expect(speedH).toBeGreaterThanOrEqual(38); // was ~18px — untappable
    expect(engineH).toBeGreaterThanOrEqual(38);
    // the current chapter is marked with more than a colour
    await page.click(".sheet:not([hidden]) .sheet-done");
    await page.click("#tocBtn");
    await expect(page.locator("#tocList button.current")).toHaveAttribute("aria-current", "true");
  });
});
