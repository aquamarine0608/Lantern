const { test, expect } = require("../helpers/fixtures");
const { importEpub, makeEpub, makeEpub2 } = require("../helpers/epub");

test.describe("library", () => {
  test("the library is the default view, with paste mode one tap away and back", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#addBookBtn")).toBeVisible();
    await expect(page.locator("#libEmpty")).toBeVisible();
    await expect(page.locator("#readBtn")).toBeHidden();

    await page.click("#pasteModeBtn");
    await expect(page.locator("#text")).toBeVisible();
    await expect(page.locator("#addBookBtn")).toBeHidden();

    await page.click("#pasteBackBtn");
    await expect(page.locator("#addBookBtn")).toBeVisible();
  });

  test("importing an EPUB puts it on the shelf with cover, title and author", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    const card = page.locator(".book");
    await expect(card).toHaveCount(1);
    await expect(card.locator(".b-title")).toHaveText("The Test Book");
    await expect(card.locator(".b-author")).toHaveText("Ada Author");
    await expect(card.locator(".cover img")).toBeVisible();
    await expect(page.locator("#libEmpty")).toBeHidden();
  });

  test("a book without a cover gets initials instead of an image", async ({ page }) => {
    await page.goto("/");
    await importEpub(page, { title: "No Cover Novel", cover: false });
    await expect(page.locator(".book .cover .initials")).toHaveText("NC");
  });

  test("the shelf persists across a reload", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);
    await page.reload();
    await expect(page.locator(".book .b-title")).toHaveText("The Test Book");
  });

  test("removing a book takes a confirm tap and sticks after reload", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    const del = page.locator(".book .b-del");
    await del.click();
    await expect(del).toHaveText("Really remove?");
    await del.click();
    await expect(page.locator(".book")).toHaveCount(0);
    await expect(page.locator("#libEmpty")).toBeVisible();
    await page.reload();
    await expect(page.locator(".book")).toHaveCount(0);
  });

  test("tapping a book that is gone from storage refreshes the shelf instead of dying silently", async ({ page }) => {
    await page.goto("/");
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);
    const id = await page.locator(".book").getAttribute("data-id");

    // a second tab/window of the same PWA removed the record since this shelf rendered
    await page.evaluate(
      (bookId) =>
        new Promise((res, rej) => {
          const open = indexedDB.open("lantern-books", 1);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("books", "readwrite");
            tx.objectStore("books").delete(bookId);
            tx.oncomplete = () => { db.close(); res(); };
            tx.onerror = () => { db.close(); rej(tx.error); };
          };
          open.onerror = () => rej(open.error);
        }),
      id
    );

    // the bounce to #library lands on the view we are already on, so showView
    // early-returns: the shelf must be refreshed here or the ghost card lives forever
    await page.click(".book-open");
    await expect(page.locator(".book")).toHaveCount(0);
    await expect(page.locator("#libEmpty")).toBeVisible();
    await expect(page.locator("#viewLibrary")).toHaveClass(/active/);
    await expect
      .poll(() => page.evaluate(() => document.getElementById("a11yAlert").textContent), { timeout: 5_000 })
      .toContain("no longer on this shelf");
  });

  test("the ghost-card refresh lands focus on the shelf, never on <body>", async ({ page }) => {
    const deleteRecord = (bookId) =>
      page.evaluate(
        (id) =>
          new Promise((res, rej) => {
            const open = indexedDB.open("lantern-books", 1);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction("books", "readwrite");
              tx.objectStore("books").delete(id);
              tx.oncomplete = () => { db.close(); res(); };
              tx.onerror = () => { db.close(); rej(tx.error); };
            };
            open.onerror = () => rej(open.error);
          }),
        bookId
      );

    await page.goto("/");
    await importEpub(page, { title: "Alpha Book" });
    await expect(page.locator(".book")).toHaveCount(1);
    await importEpub(page, { title: "Beta Book" });
    await expect(page.locator(".book")).toHaveCount(2);

    // a second tab removed the FIRST card's book since this shelf rendered
    await deleteRecord(await page.locator(".book").first().getAttribute("data-id"));
    await page.locator(".book-open").first().focus();
    await page.keyboard.press("Enter");

    await expect(page.locator(".book")).toHaveCount(1);
    // the refresh wipes the shelf out from under the focused .book-open — focus must
    // land on the card that took the ghost's slot, not on <body>
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.className), { timeout: 5_000 })
      .toContain("book-open");

    // …and with no card left to land on, the fallback is "Add a book"
    await deleteRecord(await page.locator(".book").first().getAttribute("data-id"));
    await page.locator(".book-open").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".book")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 5_000 })
      .toBe("addBookBtn");
  });

  test("cover initials never split a surrogate pair", async ({ page }) => {
    await page.goto("/");
    await importEpub(page, { title: "🌟 The Starless Sea", cover: false });
    const ini = page.locator(".book .cover .initials");
    await expect(ini).toHaveText("🌟T");
    // w[0] indexes by CODE UNIT: an astral first letter would leave a lone high
    // surrogate here, painted as a 36px U+FFFD on the cover tile
    const text = await ini.textContent();
    expect([...text].every((c) => { const n = c.codePointAt(0); return n < 0xd800 || n > 0xdfff; })).toBe(true);
  });

  test("an EPUB 2 book (NCX toc, meta cover, subdirs, encoded hrefs) imports and reads correctly", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "older.epub",
      mimeType: "application/epub+zip",
      buffer: makeEpub2(),
    });
    const card = page.locator(".book");
    await expect(card.locator(".b-title")).toHaveText("An Older Book");
    await expect(card.locator(".b-author")).toHaveText("Old Author");
    await expect(card.locator(".cover img")).toBeVisible(); // found via <meta name="cover"> and a ../ path

    await card.click();
    await expect(page.locator("#viewReader")).toBeVisible();
    // chapter labels must come from the NCX, resolved through subdir + percent-encoded hrefs
    await expect(page.locator("#rChapter")).toHaveText("Part I");
    await page.click("#tocBtn");
    const items = page.locator("#tocList button");
    await expect(items.nth(2)).toHaveText("Part III");
    await items.nth(2).click();
    await expect(page.locator(".sent").nth(1)).toContainText("The final chapter starts now.");
  });

  test("a DRM-encrypted EPUB is rejected with a clear message; font obfuscation is not", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "drm.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ encryption: "OEBPS/ch1.xhtml" }), // content file encrypted -> DRM
    });
    await expect(page.locator("#bannerText")).toContainText("DRM");
    await expect(page.locator(".book")).toHaveCount(0);

    await page.setInputFiles("#bookFile", {
      name: "fonts.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Font Obfuscated", encryption: "OEBPS/fonts/serif.otf" }), // fonts only -> fine
    });
    await expect(page.locator(".book .b-title")).toHaveText("Font Obfuscated");
  });

  test("chapters marked up entirely with <div>s keep all their text", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "divs.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ title: "Div Book", divs: true }),
    });
    await page.click(".book");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect(page.locator(".sent").nth(1)).toContainText("The first sentence opens the book.");
    await expect(page.locator(".sent")).toHaveCount(6); // nothing dropped vs the <p> layout
  });

  test("co-authored books list every author", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "coauthored.epub", mimeType: "application/epub+zip",
      buffer: makeEpub({ creators: ["Ada Author", "Bo Writer"] }),
    });
    await expect(page.locator(".book .b-author")).toHaveText("Ada Author, Bo Writer");
  });

  test("a corrupted file shows a friendly error and the shelf keeps working", async ({ page }) => {
    await page.goto("/");
    await page.setInputFiles("#bookFile", {
      name: "broken.epub",
      mimeType: "application/epub+zip",
      buffer: Buffer.from("this is definitely not a zip archive"),
    });
    await expect(page.locator("#bannerText")).toContainText("Couldn't open that EPUB");
    await expect(page.locator(".book")).toHaveCount(0);

    // a good book still imports fine afterwards, clearing the error
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);
    await expect(page.locator("#banner")).toBeHidden();
  });

  /* every other IDB call site handles rejection; the Remove-confirm handler was the
     one exception. A rejected delete threw out of the async listener, so nothing after
     it ran: no re-render, no focus restore, no announce, no banner — and the button
     was left reading "Really remove?" forever, its 3 s revert timer already cleared. */
  test("a storage failure during Remove reverts the button and says so", async ({ page }) => {
    // deterministic seam: IDBObjectStore.delete is used by dbDeleteBook and nothing
    // else, and idb() runs it inside the promise executor, so a throw rejects
    await page.addInitScript(() => {
      const origDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args) {
        if (window.__failDelete) throw new DOMException("simulated delete failure", "InvalidStateError");
        return origDelete.apply(this, args);
      };
    });
    await page.goto("/");
    await importEpub(page, { title: "Stuck Book" });
    await expect(page.locator(".book")).toHaveCount(1);

    await page.evaluate(() => { window.__failDelete = true; });
    await page.click(".book .b-del"); // arm
    await expect(page.locator(".book .b-del")).toHaveText("Really remove?");
    await page.click(".book .b-del"); // confirm — the delete rejects

    await expect(page.locator("#bannerText")).toContainText("Couldn't remove that book.");
    await expect(page.locator("#banner")).toBeVisible();
    await expect(page.locator(".book .b-del")).toHaveText("Remove"); // never stranded on "Really remove?"
    await expect(page.locator(".book")).toHaveCount(1); // still on the shelf
    await expect(page.locator(".book .b-title")).toHaveText("Stuck Book");
    // the failure reaches assistive tech too
    await expect
      .poll(() => page.evaluate(() => document.getElementById("a11yAlert").textContent), { timeout: 5_000 })
      .toContain("Couldn't remove that book");

    // and the reverted button is armable again: with storage healthy, Remove works
    await page.evaluate(() => { window.__failDelete = false; });
    await page.click(".book .b-del");
    await page.click(".book .b-del");
    await expect(page.locator(".book")).toHaveCount(0);
  });

  test("a transient storage failure doesn't leave the storage-error message on a healthy shelf", async ({ page }) => {
    // fail the FIRST indexedDB.open only — openDB() is deliberately retryable
    await page.addInitScript(() => {
      const orig = indexedDB.open.bind(indexedDB);
      let failedOnce = false;
      indexedDB.open = function (...args) {
        if (!failedOnce) {
          failedOnce = true;
          const req = {};
          setTimeout(() => {
            req.error = new DOMException("simulated open failure", "UnknownError");
            if (req.onerror) req.onerror(new Event("error"));
          }, 0);
          return req;
        }
        return orig(...args);
      };
    });
    await page.goto("/");
    await expect(page.locator("#libEmpty")).toContainText("Couldn't open Lantern's book storage");

    // navigate away and back: the retry succeeds, and the empty shelf must show
    // its real message again — not a stale "storage is broken"
    await page.click("#pasteModeBtn");
    await page.click("#pasteBackBtn");
    await expect(page.locator("#libEmpty")).toContainText("Your shelf is empty");
    await expect(page.locator("#libEmpty")).not.toContainText("Private browsing");
  });
});
