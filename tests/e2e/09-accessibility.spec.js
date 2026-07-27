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

  /* showView() toggles .active, and `.view { display:none }` unrenders the whole
     outgoing subtree — including whatever the user had focused. Every other place
     that hides a focused control (hidePlayer, closeSheets, the Remove handler, the
     import restore, the ghost-card restore) re-anchors focus; the most-travelled
     path in the app did not, so every keyboard/AT view switch dropped focus to
     <body> and restarted the next Tab at the top of the document. */
  test("every view switch re-anchors focus — the four-hop tour never lands on <body>", async ({ page }) => {
    const active = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "BODY";
        return el.id || el.className || el.tagName;
      });

    await page.goto("/");
    await importEpub(page);
    await expect(page.locator(".book")).toHaveCount(1);

    // library → paste
    await page.locator("#pasteModeBtn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#viewPaste")).toBeVisible();
    await expect.poll(active, { timeout: 5_000 }).toBe("pasteBackBtn");

    // paste → library (Enter on the control focus just landed on)
    await page.keyboard.press("Enter");
    await expect(page.locator("#viewLibrary")).toBeVisible();
    await expect.poll(active, { timeout: 5_000 }).toBe("addBookBtn");

    // library → reader, opening a book that really exists (the ghost-card branch
    // was the only one openReader ever restored focus from)
    await page.locator(".book-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#viewReader")).toBeVisible();
    await expect.poll(active, { timeout: 5_000 }).toBe("backBtn");

    // reader → library
    await page.keyboard.press("Enter");
    await expect(page.locator("#viewLibrary")).toBeVisible();
    await expect.poll(active, { timeout: 5_000 }).toBe("addBookBtn");

    // and the Tab order continues from where the user now is, not the document top
    await page.keyboard.press("Tab");
    expect(await active()).not.toBe("BODY");
  });

  /* a switch made with a sheet open (a browser back gesture, a hardware Escape)
     closes the sheet AND unrenders the view under it — the containment test has to
     see the sheet as "inside the app" or the re-anchor never fires */
  test("a view switch with a sheet open still re-anchors focus", async ({ page }) => {
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#setSheet")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement.id)).toBe("setSheet");
    await page.evaluate(() => { location.hash = "#paste"; });
    await expect(page.locator("#setSheet")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => (document.activeElement === document.body ? "BODY" : document.activeElement.id)), { timeout: 5_000 })
      .toBe("pasteBackBtn");
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

  test("an unconfirmed server draft never hijacks focus or Tab order", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "http://127.0.0.1:4174");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://other.example", v: "", k: "" }));
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.locator("#qwenUrl").focus();
    await page.keyboard.press("Tab");
    // the divergence note's one-tap adopt button is a legitimate stop after the field…
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenUseShown");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenVoice");
    await page.keyboard.press("Tab"); // used to bounce back to qwenUrl forever
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenKey");
  });

  /* the note — and the adopt button inside it — is hidden the instant the shown
     address becomes the live one, and [hidden] is display:none, so the control the
     user just activated stops being rendered. Focus fell to <body> INSIDE the open
     modal, where every other region is inert (the same defect markTocCurrent and
     closeSheets already guard against). */
  test("adopting the shown address keeps focus inside the open sheet", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://live.example");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://draft.example", v: "", k: "" }));
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.locator("#qwenUrl").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenUseShown");
    await page.keyboard.press("Enter");
    await expect(page.locator("#qwenDraftNote")).toBeHidden();
    await expect(page.locator("#setSheet")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenUrl"); // used to be BODY
    await page.keyboard.press("Tab"); // and the documented Tab order still holds
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenVoice");
  });

  /* The same [hidden] = display:none hazard, reached the other way round: the note
     collapses from the Server field's BLUR commit, and Tab out of that field lands on
     #qwenUseShown — inside the note. The deferred collapse then unrendered the very
     button focus had just moved to, dropping focus to <body> inside the open modal
     where every sheetInert region is inert. The round-28 guard could not catch this:
     it lives in the button's own click handler, which a Tab never dispatches. */
  test("tabbing out of the Server field never strands focus on the collapsing note", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://old-host.example"); // live, no draft
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await page.fill("#qwenUrl", "https://new-host.example"); // fill = typed = touched, so blur commits
    await expect(page.locator("#qwenDraftNote")).toBeVisible();
    await page.keyboard.press("Tab"); // focus lands on #qwenUseShown while the commit collapses the note
    await expect(page.locator("#qwenDraftNote")).toBeHidden();
    await expect(page.locator("#setSheet")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.activeElement.id), { timeout: 2_000 })
      .toBe("qwenUrl"); // used to be BODY, inert-trapped
    await page.keyboard.press("Tab"); // and the documented Tab order still holds
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenVoice");
  });

  /* and the pointer path at a real press length: the collapse is HELD while the button
     is down, so the click still reaches qwenUseShown's handler, which flushes the held
     collapse itself (belt and braces with the guard above — either one alone keeps
     focus off <body> here; only both keep it off on every path) */
  test("a real-length press on Use this address keeps focus in the sheet", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("lantern.engine", "qwen");
      localStorage.setItem("lantern.qwenUrl", "https://live.example");
      localStorage.setItem("lantern.qwenDraft", JSON.stringify({ u: "https://draft.example", v: "", k: "" }));
    });
    await page.goto("/");
    await page.click("#libVoiceBtn");
    await expect(page.locator("#qwenUseShown")).toBeVisible();
    await page.click("#qwenUseShown", { delay: 80 });
    await expect(page.locator("#qwenDraftNote")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("lantern.qwenUrl"))).toBe("https://draft.example");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenUrl"); // never BODY
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement.id)).toBe("qwenVoice");
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

  test("removing a book keeps focus on the shelf and announces the removal", async ({ page }) => {
    await page.goto("/");
    await importEpub(page, { title: "Alpha Book" });
    await expect(page.locator(".book")).toHaveCount(1);
    await importEpub(page, { title: "Beta Book" });
    await expect(page.locator(".book")).toHaveCount(2);

    // remove the first card from the keyboard: arm, then confirm
    await page.locator(".book .b-del").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".book .b-del").first()).toHaveText("Really remove?");
    await page.keyboard.press("Enter");

    await expect(page.locator(".book")).toHaveCount(1);
    // renderLibrary wipes the shelf — focus must land on the card that took this
    // one's place, never on <body>
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.className), { timeout: 5_000 })
      .toContain("b-del");
    await expect
      .poll(() => page.evaluate(() => document.getElementById("a11yAlert").textContent), { timeout: 5_000 })
      .toContain("Removed");

    // the last book: there is no card left to land on, so fall back to "Add a book"
    await page.keyboard.press("Enter");
    await expect(page.locator(".book .b-del").first()).toHaveText("Really remove?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".book")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 5_000 })
      .toBe("addBookBtn");
  });

  /* #playBtn lives inside #player, is never disabled, and is the very next Tab stop
     after #readBtn for the whole warm-up / generation window. [hidden] is
     display:none, so the failure paths that hide the player unrender the focused
     button — focus must land on the primary action, not fall to <body> exactly as an
     error banner asks for attention. */
  test("a failed model download hands focus back to Read aloud, not <body>", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 2000, loadFail: true, chunkDelay: 50, chunkSeconds: 0.4 });
    await page.goto("/#paste");
    await page.fill("#text", "One sentence only here.");
    await page.locator("#readBtn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#player")).toBeVisible();

    await page.keyboard.press("Tab"); // the Pause button, live for the whole download
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("playBtn");

    await expect(page.locator("#bannerText")).toContainText("Couldn't fetch the voice model", { timeout: 20_000 });
    await expect(page.locator("#player")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 5_000 })
      .toBe("readBtn");
  });

  test("a reading that produces no audio hands focus back to Read aloud, not <body>", async ({ page, mockTTS }) => {
    await mockTTS({ loadDelay: 20, chunkDelay: 500, chunkSeconds: 0 });
    await page.goto("/#paste");
    await page.fill("#text", "One. Two.");
    await page.locator("#readBtn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#player")).toBeVisible();

    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe("playBtn");

    await expect(page.locator("#bannerText")).toContainText("isn't producing any audio", { timeout: 20_000 });
    await expect(page.locator("#player")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 5_000 })
      .toBe("readBtn");
  });

  test("a keyboard import hands focus back to the Add a book button", async ({ page }) => {
    await page.goto("/");
    await page.locator("#addBookBtn").focus();
    expect(await page.evaluate(() => document.activeElement.id)).toBe("addBookBtn");
    // the change event is dispatched with the button still focused; disabling it
    // there drops focus to <body> unless the finally hands it back
    await importEpub(page);
    await expect(page.locator(".book .b-title")).toHaveText("The Test Book");
    await expect(page.locator("#addBookBtn")).toHaveText("Add a book · EPUB"); // the import has settled
    await expect
      .poll(() => page.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 5_000 })
      .toBe("addBookBtn");
  });
});
