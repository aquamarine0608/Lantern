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
