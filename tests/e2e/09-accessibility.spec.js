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
});
