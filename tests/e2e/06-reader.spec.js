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
        chapters: [{
          title: "Verse",
          paras: [
            "<!-- pagebreak 42 -->",
            "Half a league,<br/>Half a league onward.",
            "<span>My dear Watson,<br/>Come at once.</span>", // <br> nested in an inline element
          ],
        }],
      }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined).not.toContain("pagebreak"); // converter leftovers must not be read aloud
    expect(joined).toMatch(/league, Half/); // a direct <br> must separate words
    expect(joined).toMatch(/Watson, Come/); // ...and so must one nested inside a <span>
  });

  test("no synthesis unit ever exceeds the engine's context window", async ({ page }) => {
    const endless = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(35).trim();
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "endless.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Endless", chapters: [{ title: "Run-on", paras: [endless] }] }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const lens = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent.length));
    expect(Math.max(...lens)).toBeLessThanOrEqual(322); // kokoro silently truncates past ~510 phoneme tokens
    expect(lens.length).toBeGreaterThan(5); // the run-on text was actually split
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined.replace(/\s+/g, " ").trim().length).toBeGreaterThanOrEqual(endless.length); // and nothing was lost
  });

  test("CJK text splits at 。！？ and no spaces are injected between sentences", async ({ page }) => {
    const source = "夜が明けた。空は青かった。「行こう」と彼は言った。彼女は笑った！本当に？";
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "cjk.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "CJK Book", chapters: [{ title: "第一章", paras: [source] }] }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    // 1 heading + 5 sentences: without the CJK terminators the whole paragraph is one giant unit
    await expect(page.locator(".sent")).toHaveCount(6);
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined).toContain(source); // rejoining the spans reproduces the text byte-for-byte — no injected spaces
  });

  test("a length cut never splits a surrogate pair (emoji stays intact)", async ({ page }) => {
    // 319 chars then an emoji: the 320-char hard cut lands exactly between its surrogates
    const source = "a".repeat(319) + "😀" + "b".repeat(40);
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "emoji.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Emoji Book", chapters: [{ title: "Edge", paras: [source] }] }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const texts = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent));
    const joined = texts.join("");
    expect(joined).toContain("😀");
    expect(joined).not.toContain("�");
    for (const t of texts) expect(/[\uD800-\uDBFF]\s*$/.test(t)).toBe(false); // no span ends on a lone high surrogate
  });

  test("back returns to the library", async ({ page }) => {
    await openFirstBook(page);
    await page.click("#backBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await expect(page.locator("#viewReader")).toBeHidden();
  });
});
