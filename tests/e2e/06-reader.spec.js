const { test, expect } = require("../helpers/fixtures");
const { importEpub, makeEpub } = require("../helpers/epub");

async function openFirstBook(page) {
  await page.goto("/");
  await importEpub(page);
  await page.click(".book");
  await expect(page.locator("#viewReader")).toBeVisible();
}

test.describe("reader view", () => {
  test("opening a book renders the first chapter as tappable sentences", async ({ page }) => {
    await openFirstBook(page);
    await expect(page.locator("#rBook")).toHaveText("The Test Book");
    await expect(page.locator("#rChapter")).toHaveText("Chapter One");
    // the in-content heading is spoken too, so it is sentence 0, styled as a heading
    await expect(page.locator(".sent").first()).toHaveText(/Chapter One/);
    await expect(page.locator(".sent").nth(1)).toContainText("The first sentence opens the book.");
    // heading + 3 sentences + 2 sentences across two paragraphs
    await expect(page.locator(".sent")).toHaveCount(6);
    await expect(page.locator("#rStatus")).toContainText("Chapter 1 of 3");
  });

  test("the table of contents lists and switches chapters", async ({ page }) => {
    await openFirstBook(page);
    await page.click("#tocBtn");
    const items = page.locator("#tocList button");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveClass(/current/);
    await items.nth(1).click();
    await expect(page.locator("#rChapter")).toHaveText("Chapter Two");
    await expect(page.locator(".sent").nth(1)).toContainText("Chapter two begins with this line.");
    await expect(page.locator("#tocSheet")).toBeHidden();
  });

  test("text size adjusts, applies to the content, and persists", async ({ page }) => {
    await openFirstBook(page);
    await page.click("#fontBtn");
    await page.click("#fontPlus");
    await page.click("#fontPlus");
    await expect(page.locator("#fontVal")).toHaveText("21");
    // nth(1) is a body sentence — sentence 0 sits in the heading, which scales by 1.35em
    const size = await page.locator(".sent").nth(1).evaluate((el) => getComputedStyle(el).fontSize);
    expect(size).toBe("21px");

    await page.reload();
    await expect(page.locator("#rChapter")).toHaveText("Chapter One"); // deep link restored the book
    const size2 = await page.locator(".sent").nth(1).evaluate((el) => getComputedStyle(el).fontSize);
    expect(size2).toBe("21px");
  });

  test("text with decimals, URLs and initials is never dropped by sentence splitting", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "tricky.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({
        title: "Tricky Text",
        chapters: [{ title: "Numbers", paras: ["It cost 3.14 dollars and he paid it. Visit https://example.com/page.html now. The U.S.A. is big."] }],
      }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined).toContain("It cost 3.14 dollars"); // String.match-based splitting used to silently delete this
    expect(joined).toContain("https://example.com/page.html");
    expect(joined).toContain("U.S.A. is big");
  });

  test("HTML comments are never spoken and <br> lines keep their word boundary", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "verse.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({
        title: "Verse Book",
        chapters: [{ title: "Verse", paras: ["<!-- pagebreak 42 -->", "Half a league,<br/>Half a league onward."] }],
      }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined).not.toContain("pagebreak"); // converter leftovers must not be read aloud
    expect(joined).toMatch(/league, Half/); // the <br> must separate words, not glue them
  });

  test("back returns to the library", async ({ page }) => {
    await openFirstBook(page);
    await page.click("#backBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await expect(page.locator("#viewReader")).toBeHidden();
  });
});
