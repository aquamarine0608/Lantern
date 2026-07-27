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

  test("Chinese curly-quote endings get no injected space; English keeps its real one", async ({ page }) => {
    const zh = "他说：“今天天气很好。”然后他走了。";
    const en = "He said, “Hello there.” Then he left.";
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "quotes.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Quotes Book", chapters: [{ title: "引号", paras: [zh, en] }] }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined).toContain("。”然后"); // ” after 。 is still CJK-final — no injected space
    expect(joined).toContain(".” Then"); // the same ” after an English period keeps its real space
  });

  test("Korean keeps its inter-word space at a length-cut seam (Hangul is not 'no-space' CJK)", async ({ page }) => {
    // >320 chars of spaced Hangul: the cap cuts at a space, the left span ends in a syllable,
    // and a NO_SPACE_AFTER class that wrongly covers Hangul would glue the two spans together
    const source = "가나다라마바사 ".repeat(50).trim();
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "korean.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Korean Book", chapters: [{ title: "한글", paras: [source] }] }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const joined = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent).join(""));
    expect(joined).toContain("사 가"); // the seam keeps the word boundary
    expect(joined).not.toContain("사가"); // never glued
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

  test("a TOC with sub-section entries still shows the chapter's own title", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "sections.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Sectioned Book", subEntries: true }), // ch1.xhtml + ch1.xhtml#sec1 + ch1.xhtml#sec2
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    // sub-entry fragments collapse onto the chapter's file: the LAST entry must not win
    await expect(page.locator("#rChapter")).toHaveText("Chapter One");
    await page.click("#tocBtn");
    await expect(page.locator("#tocList button").nth(0)).toHaveText(/^Chapter One$/);
    await page.locator("#tocList button").nth(0).click();
    // the real chapter heading keeps its heading styling too
    await expect(page.locator(".sent").first()).toHaveText(/Chapter One/);
  });

  /* German (and Czech/Slovak) close a quotation with “ (U+201C) — the very codepoint
     Simplified Chinese OPENS with. It was missing from SENT_END_RE's Latin closing
     class, so `(?=\s|$)` failed right after the period and the whole „…“ sentence ran
     on into the next one. The CJK branch must stay untouched. */
  test("German „…“ quotes end a sentence; a Chinese opening “ still does not", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "german.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({
        title: "Deutsches Buch",
        chapters: [{
          title: "Kapitel",
          paras: [
            "Sie sagte: „Ich komme später.“ Dann ging sie nach Hause.",
            "Er sagte: ‚Hallo.‘ Dann ging er.",
            "他说：“我来了。”然后他走了。",
          ],
        }],
      }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const texts = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent));
    // heading + 2 + 2 + 2 = 7 units; before the fix each German paragraph stayed one
    expect(texts).toHaveLength(7);
    expect(texts[1]).toMatch(/^Sie sagte: „Ich komme später\.“\s*$/);
    expect(texts[2]).toMatch(/^Dann ging sie nach Hause\.\s*$/);
    expect(texts[3]).toMatch(/^Er sagte: ‚Hallo\.‘\s*$/);
    expect(texts[5]).toBe("他说：“我来了。”"); // CJK branch unchanged — no injected space, closer kept
    expect(texts.join("")).toContain("他说：“我来了。”然后他走了。");
  });

  /* a closed-up em dash (word—word) is standard American prose typography for a
     parenthetical aside. It was not in ABBREV_END_RE's leading-boundary class, so a
     title abbreviation sitting right after one ("person—Mr.") read as a sentence end
     and cut the audio mid-name. */
  test("an abbreviation right after a closed-up dash does not split the sentence", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "dashes.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({
        title: "Dash Book",
        chapters: [{
          title: "Chapter One",
          paras: [
            "Only one person—Mr. Harding—understood the plan. He was later thanked.",
            "It was the end—Mr. Bennet arrived. He left.",
            "She called—Dr. Watson answered. Then silence.",
          ],
        }],
      }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").first()).toBeVisible();
    const texts = await page.evaluate(() => [...document.querySelectorAll(".sent")].map((e) => e.textContent));
    expect(texts).toHaveLength(7); // heading + 2 + 2 + 2, not 10
    expect(texts[1]).toMatch(/^Only one person—Mr\. Harding—understood the plan\.\s*$/);
    expect(texts[3]).toMatch(/^It was the end—Mr\. Bennet arrived\.\s*$/);
    expect(texts[5]).toMatch(/^She called—Dr\. Watson answered\.\s*$/);
  });

  test("back returns to the library", async ({ page }) => {
    await openFirstBook(page);
    await page.click("#backBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await expect(page.locator("#viewReader")).toBeHidden();
  });

  test("abbreviations like Mr. and a.m. do not split sentences apart", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "abbrev.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({
        title: "Abbrev Book",
        chapters: [{
          title: "Chapter One",
          paras: [
            "My dear Mr. Bennet, said his lady to him one day, have you heard that Netherfield Park is let at last?",
            "Dr. Watson reached No. 10 at 8 a.m. the next morning. We arrived late.",
          ],
        }],
      }),
    });
    await page.click(".book");
    await expect(page.locator(".sent").first()).toBeVisible();
    // title + one whole quoted sentence + two real sentences = 4 units, not 8
    // (spans keep their original trailing spaces so rejoins stay byte-exact)
    await expect(page.locator(".sent")).toHaveCount(4);
    await expect(page.locator(".sent").nth(1)).toHaveText(/^My dear Mr\. Bennet.*at last\?\s*$/);
    await expect(page.locator(".sent").nth(2)).toHaveText(/^Dr\. Watson reached No\. 10 at 8 a\.m\. the next morning\.\s*$/);
    await expect(page.locator(".sent").nth(3)).toHaveText(/^We arrived late\.\s*$/);
  });
  /* .r-scroll declares only overflow-y, which per CSS Overflow promotes overflow-x to
     auto as well: without a wrap opportunity a single over-long token doesn't reflow,
     it rides off the right edge with no ellipsis and (on iOS overlay scrollbars) no
     hint that anything is hidden. block:"center" scrollIntoView is vertical only. */
  test("an unbreakable token wraps instead of clipping off the reading column", async ({ page }) => {
    await page.goto("/");
    await importEpub(page, {
      cover: false,
      chapters: [{ title: "Long Tokens", paras: ["See https://example.com/" + "x".repeat(99) + " and the sentence carries on afterwards."] }],
    });
    await page.click(".book");
    await expect(page.locator(".sent").first()).toBeVisible();
    const over = await page.evaluate(() => {
      const rs = document.getElementById("rScroll");
      return rs.scrollWidth - rs.clientWidth;
    });
    expect(over).toBe(0);
  });

  test("an RTL book resolves its own direction on the shelf, in the chapter list and in the reading pane", async ({ page }) => {
    await page.goto("/");
    await importEpub(page, {
      title: "ספר הבדיקה",
      author: "מחבר עברי",
      cover: false,
      chapters: [
        { title: "פרק ראשון", paras: ["זהו המשפט הראשון בספר. וזהו המשפט השני שלו."] },
        { title: "פרק שני", paras: ["המשך הסיפור מופיע כאן."] },
      ],
    });
    const dirOf = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).direction);
    expect(await dirOf(".b-title")).toBe("rtl");
    expect(await dirOf(".b-author")).toBe("rtl");
    // and the physical alignment is gone, so "start" follows the resolved direction
    expect(await page.locator(".book-open").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("start");

    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    expect(await dirOf("#rContent p")).toBe("rtl");
    expect(await dirOf("#rBook")).toBe("rtl");
    expect(await dirOf("#rChapter")).toBe("rtl");
    // the sentence spans stay inside their paragraph's single bidi run
    expect(await page.locator(".sent").first().evaluate((el) => el.hasAttribute("dir"))).toBe(false);

    await page.click("#tocBtn");
    expect(await dirOf("#tocList button")).toBe("rtl");
    expect(await page.locator("#tocList button").first().evaluate((el) => getComputedStyle(el).textAlign)).toBe("start");
  });

  /* A missing id and a missing idref are both spec violations that getAttribute
     reports as the SAME null, so a Map keyed on the raw value makes them meet: the
     bare <itemref/> resolves to the last id-less <item> and reads out a file that is
     in no reading order at all. */
  test("a spine itemref with no idref cannot pull in a manifest item with no id", async ({ page }) => {
    await page.goto("/");
    await importEpub(page, { orphanItem: true, cover: false });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await page.click("#tocBtn");
    await expect(page.locator("#tocList button")).toHaveCount(3);
    expect(await page.locator("#tocList button").allTextContents())
      .toEqual(["Chapter One", "Chapter Two", "Chapter Three"]);
    // and the unreferenced file's text is nowhere in the book
    for (let i = 0; i < 3; i++) {
      await page.locator("#tocList button").nth(i).click();
      await expect(page.locator("#rContent")).not.toContainText("not in the reading order");
      if (i < 2) await page.click("#tocBtn");
    }
  });
});
