const { test, expect } = require("../helpers/fixtures");

async function openModulePage(page) {
  await page.goto("/native-tts-adapter.js");
}

async function installFakeBridge(page, { autoReply = true } = {}) {
  await page.evaluate(({ autoReply }) => {
    const fake = {
      autoReply,
      messages: [],
      pendingReplies: [],
      reply(index, patch = {}) {
        const request = this.messages[index];
        if (!request) throw new Error(`no native request at index ${index}`);
        const pending = this.pendingReplies[index];
        if (!pending || pending.settled) return false;
        pending.settled = true;
        pending.resolve({
          protocol: "lantern.native-tts",
          version: 1,
          type: "reply",
          requestId: request.requestId,
          ok: true,
          result: { accepted: true, method: request.method },
          ...patch,
        });
        return true;
      },
      reject(index, error = new Error("native reply rejected")) {
        const pending = this.pendingReplies[index];
        if (!pending || pending.settled) return false;
        pending.settled = true;
        pending.reject(error);
        return true;
      },
      emit(index, event, payload, patch = {}) {
        const request = this.messages[index];
        if (!request) throw new Error(`no native request at index ${index}`);
        const receive = window[request.eventReceiver];
        if (typeof receive !== "function") return false;
        receive({
          protocol: "lantern.native-tts",
          version: 1,
          type: "event",
          event,
          requestId: request.requestId,
          sessionId: request.sessionId,
          payload,
          ...patch,
        });
        return true;
      },
    };
    window.__NATIVE_FAKE__ = fake;
    Object.defineProperty(window, "webkit", {
      configurable: true,
      writable: true,
      value: {
        messageHandlers: {
          lantern: {
            postMessage(message) {
              fake.messages.push(message);
              const index = fake.messages.length - 1;
              const promise = new Promise((resolve, reject) => {
                fake.pendingReplies[index] = { resolve, reject, settled: false };
              });
              if (fake.autoReply) queueMicrotask(() => fake.reply(index));
              return promise;
            },
          },
        },
      },
    });
  }, { autoReply });
}

async function createAdapter(page, options = {}) {
  await page.evaluate(async options => {
    window.__NATIVE_MOD__ = await import("/native-tts-adapter.js");
    window.__NATIVE_ADAPTER__ = window.__NATIVE_MOD__.createNativeTTSAdapter(options);
  }, options);
}

async function waitForMessages(page, count) {
  await expect.poll(() => page.evaluate(() => window.__NATIVE_FAKE__.messages.length)).toBe(count);
}

test.describe("native TTS bridge adapter", () => {
  test.beforeEach(async ({ page }) => {
    await openModulePage(page);
  });

  test("reports capability and exposes every versioned control-plane operation", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);

    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      const events = [];
      for (const name of [
        "model.progress", "model.ready", "tts.buffering", "tts.started",
        "tts.position", "tts.ended", "reader.sentenceStarted", "error",
      ]) adapter.on(name, detail => events.push({ name, detail }));

      await adapter.model.status();
      await adapter.model.download({ revision: "qwen-0.6b-test" });
      const downloadIndex = window.__NATIVE_FAKE__.messages.length - 1;
      window.__NATIVE_FAKE__.emit(downloadIndex, "model.progress", { loaded: 4, total: 10, file: "model.bin" }, { sessionId: null });
      window.__NATIVE_FAKE__.emit(downloadIndex, "model.ready", { modelRevision: "qwen-0.6b-test" }, { sessionId: null });
      await adapter.model.cancelDownload();
      await adapter.model.delete();
      await adapter.tts.prepare({ modelRevision: "qwen-0.6b-test" });
      await adapter.tts.setVoice("Aiden");
      await adapter.tts.setSpeed(1.2);

      const first = await adapter.tts.start({ bookId: "book-1" });
      const firstStartIndex = window.__NATIVE_FAKE__.messages.length - 1;
      window.__NATIVE_FAKE__.emit(firstStartIndex, "tts.buffering", { bufferedSeconds: 1.25 });
      window.__NATIVE_FAKE__.emit(firstStartIndex, "tts.started", { positionSeconds: 0 });
      window.__NATIVE_FAKE__.emit(firstStartIndex, "tts.position", { positionSeconds: 0.4, sentenceId: "s-0" });
      window.__NATIVE_FAKE__.emit(firstStartIndex, "reader.sentenceStarted", { sentenceId: "s-0", index: 0 });
      await adapter.tts.enqueue("The lantern glows.", { sentenceId: "s-0", index: 0 });
      await adapter.tts.pause();
      await adapter.tts.resume();
      window.__NATIVE_FAKE__.emit(firstStartIndex, "tts.ended", { reason: "completed" });

      const second = await adapter.tts.start({ bookId: "book-1" });
      await adapter.tts.stop();
      return {
        available: adapter.available,
        capability: adapter.capability,
        firstSession: first.sessionId,
        secondSession: second.sessionId,
        events,
        messages: window.__NATIVE_FAKE__.messages,
      };
    });

    expect(result.available).toBe(true);
    expect(result.capability).toEqual({
      available: true,
      protocol: "lantern.native-tts",
      version: 1,
      transportsPCM: false,
    });
    expect(result.firstSession).not.toBe(result.secondSession);
    expect(result.events.map(e => e.name)).toEqual([
      "model.progress", "model.ready", "tts.buffering", "tts.started",
      "tts.position", "reader.sentenceStarted", "tts.ended",
    ]);
    expect(result.messages.map(m => m.method)).toEqual([
      "model.status", "model.download", "model.cancelDownload", "model.delete",
      "tts.prepare", "tts.setVoice", "tts.setSpeed", "tts.start",
      "tts.enqueue", "tts.pause", "tts.resume", "tts.start", "tts.stop",
    ]);
    for (const message of result.messages) {
      expect(message.protocol).toBe("lantern.native-tts");
      expect(message.version).toBe(1);
      expect(message.type).toBe("request");
      expect(message.requestId).toMatch(/:request:\d+$/);
      expect(message.eventReceiver).toMatch(/^__lanternNativeTTSReceiveV1_/);
    }
  });

  test("fails with a typed error when the WKWebView bridge is unavailable", async ({ page }) => {
    await page.evaluate(() => { delete window.webkit; });
    await createAdapter(page);
    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      try { await adapter.model.status(); }
      catch (error) {
        return { available: adapter.available, capability: adapter.capability, name: error.name, code: error.code };
      }
    });
    expect(result).toEqual({
      available: false,
      capability: { available: false, protocol: "lantern.native-tts", version: 1, transportsPCM: false },
      name: "NativeTTSUnavailableError",
      code: "BRIDGE_UNAVAILABLE",
    });
  });

  test("rejects a malformed matching reply with a typed protocol error", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page);
    const pending = page.evaluate(async () => {
      try { await window.__NATIVE_ADAPTER__.model.status(); }
      catch (error) { return { name: error.name, code: error.code, message: error.message }; }
    });
    await waitForMessages(page, 1);
    await page.evaluate(() => {
      window.__NATIVE_FAKE__.reply(0, { version: 999, ok: "yes", result: [] });
    });
    const result = await pending;
    expect(result.name).toBe("NativeTTSProtocolError");
    expect(result.code).toBe("PROTOCOL_ERROR");
    expect(result.message).toContain("protocol envelope");
  });

  test("maps a well-formed native failure to a typed operation error", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page);
    const pending = page.evaluate(async () => {
      try { await window.__NATIVE_ADAPTER__.tts.prepare(); }
      catch (error) { return { name: error.name, code: error.code, message: error.message, method: error.method }; }
    });
    await waitForMessages(page, 1);
    await page.evaluate(() => {
      window.__NATIVE_FAKE__.reply(0, {
        ok: false,
        result: null,
        error: { code: "MODEL_OOM", message: "The model did not fit", details: { stage: "load" } },
      });
    });
    expect(await pending).toEqual({
      name: "NativeTTSOperationError",
      code: "MODEL_OOM",
      message: "The model did not fit",
      method: "tts.prepare",
    });
  });

  test("maps a rejected native reply Promise to a typed bridge error", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page);
    const pending = page.evaluate(async () => {
      try { await window.__NATIVE_ADAPTER__.model.status(); }
      catch (error) {
        return { name: error.name, code: error.code, message: error.message, details: error.details };
      }
    });
    await waitForMessages(page, 1);
    expect(await page.evaluate(() => window.__NATIVE_FAKE__.reject(0, new Error("native exploded")))).toBe(true);
    expect(await pending).toEqual({
      name: "NativeTTSBridgeError",
      code: "NATIVE_REPLY_REJECTED",
      message: "Native TTS reply Promise rejected: model.status",
      details: { method: "model.status", cause: "native exploded" },
    });
  });

  test("times out, removes the request, and ignores its late reply", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page, { timeoutMs: 35 });
    const result = await page.evaluate(async () => {
      try { await window.__NATIVE_ADAPTER__.model.status(); }
      catch (error) { return { name: error.name, code: error.code }; }
    });
    expect(result).toEqual({ name: "NativeTTSTimeoutError", code: "BRIDGE_TIMEOUT" });
    expect(await page.evaluate(() => window.__NATIVE_FAKE__.reply(0))).toBe(true); // native Promise resolves; adapter request is gone

    const next = page.evaluate(() => window.__NATIVE_ADAPTER__.model.status());
    await waitForMessages(page, 2);
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(1));
    await expect(next).resolves.toMatchObject({ accepted: true, method: "model.status" });
  });

  test("gives prepare a 60-second default while preserving an explicit caller timeout", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page);
    expect(await page.evaluate(() => window.__NATIVE_ADAPTER__._prepareTimeoutMs)).toBe(60_000);
    await page.evaluate(() => window.__NATIVE_ADAPTER__.dispose());
    await createAdapter(page, { timeoutMs: 25, prepareTimeoutMs: 2_000 });

    await page.evaluate(() => {
      const state = window.__PREPARE_STATE__ = { settled: false };
      window.__PREPARE_DEFAULT__ = window.__NATIVE_ADAPTER__.tts.prepare().then(
        value => { state.settled = true; return { ok: true, value }; },
        error => { state.settled = true; return { ok: false, code: error.code }; }
      );
    });
    await waitForMessages(page, 1);
    await page.waitForTimeout(75); // Longer than the adapter's ordinary 25 ms default.
    expect(await page.evaluate(() => window.__PREPARE_STATE__.settled)).toBe(false);
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(0));
    await expect(page.evaluate(() => window.__PREPARE_DEFAULT__)).resolves.toMatchObject({ ok: true });

    const explicit = page.evaluate(async () => {
      try { await window.__NATIVE_ADAPTER__.tts.prepare({}, { timeoutMs: 30 }); }
      catch (error) { return { name: error.name, code: error.code, timeoutMs: error.details.timeoutMs }; }
    });
    await waitForMessages(page, 2);
    expect(await explicit).toEqual({ name: "NativeTTSTimeoutError", code: "BRIDGE_TIMEOUT", timeoutMs: 30 });
    expect(await page.evaluate(() => window.__NATIVE_FAKE__.reply(1))).toBe(true);
  });

  test("honours AbortSignal and fences the reply that arrives after abort", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page);
    const pending = page.evaluate(async () => {
      const ctl = new AbortController();
      window.__NATIVE_ABORT__ = ctl;
      try { await window.__NATIVE_ADAPTER__.model.download({}, { signal: ctl.signal }); }
      catch (error) { return { name: error.name, code: error.code }; }
    });
    await waitForMessages(page, 1);
    await page.evaluate(() => window.__NATIVE_ABORT__.abort());
    expect(await pending).toEqual({ name: "AbortError", code: "ABORTED" });
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(0));

    const alreadyAborted = await page.evaluate(async () => {
      const ctl = new AbortController(); ctl.abort();
      const before = window.__NATIVE_FAKE__.messages.length;
      try { await window.__NATIVE_ADAPTER__.model.status({ signal: ctl.signal }); }
      catch (error) { return { code: error.code, posted: window.__NATIVE_FAKE__.messages.length - before }; }
    });
    expect(alreadyAborted).toEqual({ code: "ABORTED", posted: 0 });
  });

  test("delivers events only for the current TTS session", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);
    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      const positions = [];
      adapter.on("tts.position", e => positions.push(e.payload.positionSeconds));
      const oldSession = await adapter.tts.start();
      const oldIndex = window.__NATIVE_FAKE__.messages.length - 1;
      const newSession = await adapter.tts.start();
      const newIndex = window.__NATIVE_FAKE__.messages.length - 1;
      window.__NATIVE_FAKE__.emit(oldIndex, "tts.position", { positionSeconds: 9 });
      window.__NATIVE_FAKE__.emit(newIndex, "tts.position", { positionSeconds: 1 });
      await adapter.tts.stop();
      window.__NATIVE_FAKE__.emit(newIndex, "tts.position", { positionSeconds: 2 });
      return { positions, oldSession: oldSession.sessionId, newSession: newSession.sessionId };
    });
    expect(result.oldSession).not.toBe(result.newSession);
    expect(result.positions).toEqual([1]);
  });

  test("queue drain keeps the session usable until stop and later starts still supersede", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);
    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      let ended = 0;
      adapter.on("tts.ended", () => ended++);
      const first = await adapter.tts.start({ bookId: "book-drain" });
      const firstIndex = window.__NATIVE_FAKE__.messages.length - 1;
      window.__NATIVE_FAKE__.emit(firstIndex, "tts.ended", { reason: "completed" });
      const activeAfterDrain = adapter.activeSessionId;
      await adapter.tts.enqueue("More text after the queue drained.", { sentenceId: "s-next", index: 1 });
      await adapter.tts.pause();
      await adapter.tts.stop();
      const activeAfterStop = adapter.activeSessionId;

      const second = await adapter.tts.start();
      const third = await adapter.tts.start();
      return {
        ended,
        first: first.sessionId,
        second: second.sessionId,
        third: third.sessionId,
        activeAfterDrain,
        activeAfterStop,
        activeAfterSupersede: adapter.activeSessionId,
        messages: window.__NATIVE_FAKE__.messages.map(({ method, sessionId }) => ({ method, sessionId })),
      };
    });
    expect(result.ended).toBe(1);
    expect(result.activeAfterDrain).toBe(result.first);
    expect(result.activeAfterStop).toBeNull();
    expect(result.second).not.toBe(result.third);
    expect(result.activeAfterSupersede).toBe(result.third);
    expect(result.messages.slice(0, 4)).toEqual([
      { method: "tts.start", sessionId: result.first },
      { method: "tts.enqueue", sessionId: result.first },
      { method: "tts.pause", sessionId: result.first },
      { method: "tts.stop", sessionId: result.first },
    ]);
  });

  test("retains the session after a failed stop so stop can be retried", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);
    const sessionId = await page.evaluate(async () => (await window.__NATIVE_ADAPTER__.tts.start()).sessionId);
    await page.evaluate(() => {
      window.__NATIVE_FAKE__.autoReply = false;
      window.__STOP_ATTEMPT__ = window.__NATIVE_ADAPTER__.tts.stop().then(
        () => ({ resolved: true }),
        error => ({ name: error.name, code: error.code })
      );
    });
    await waitForMessages(page, 2);
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(1, {
      ok: false,
      result: null,
      error: { code: "STOP_FAILED", message: "Audio teardown failed" },
    }));
    expect(await page.evaluate(async () => ({
      attempt: await window.__STOP_ATTEMPT__,
      activeSessionId: window.__NATIVE_ADAPTER__.activeSessionId,
    }))).toEqual({
      attempt: { name: "NativeTTSOperationError", code: "STOP_FAILED" },
      activeSessionId: sessionId,
    });

    await page.evaluate(() => { window.__STOP_RETRY__ = window.__NATIVE_ADAPTER__.tts.stop(); });
    await waitForMessages(page, 3);
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(2));
    await page.evaluate(() => window.__STOP_RETRY__);
    expect(await page.evaluate(() => ({
      activeSessionId: window.__NATIVE_ADAPTER__.activeSessionId,
      retrySessionId: window.__NATIVE_FAKE__.messages[2].sessionId,
    }))).toEqual({ activeSessionId: null, retrySessionId: sessionId });
  });

  test("restores the previous session when a superseding start fails", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);
    const firstSessionId = await page.evaluate(async () => (await window.__NATIVE_ADAPTER__.tts.start()).sessionId);
    await page.evaluate(() => {
      window.__NATIVE_FAKE__.autoReply = false;
      window.__SUPERSEDING_START__ = window.__NATIVE_ADAPTER__.tts.start().then(
        () => ({ resolved: true }),
        error => ({ name: error.name, code: error.code })
      );
    });
    await waitForMessages(page, 2);
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(1, {
      ok: false,
      result: null,
      error: { code: "START_FAILED", message: "Could not replace playback" },
    }));
    expect(await page.evaluate(async () => ({
      attempt: await window.__SUPERSEDING_START__,
      activeSessionId: window.__NATIVE_ADAPTER__.activeSessionId,
    }))).toEqual({
      attempt: { name: "NativeTTSOperationError", code: "START_FAILED" },
      activeSessionId: firstSessionId,
    });

    await page.evaluate(() => { window.__RESTORED_PAUSE__ = window.__NATIVE_ADAPTER__.tts.pause(); });
    await waitForMessages(page, 3);
    await page.evaluate(() => window.__NATIVE_FAKE__.reply(2));
    await page.evaluate(() => window.__RESTORED_PAUSE__);
    expect(await page.evaluate(() => window.__NATIVE_FAKE__.messages[2].sessionId)).toBe(firstSessionId);
  });

  test("fences model events after cancel and ignores unknown or malformed events", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);
    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      const seen = [];
      adapter.on("model.progress", e => seen.push(["progress", e.payload.loaded]));
      adapter.on("error", e => seen.push(["error", e.payload.code]));
      await adapter.model.download();
      const downloadIndex = window.__NATIVE_FAKE__.messages.length - 1;
      window.__NATIVE_FAKE__.emit(downloadIndex, "model.progress", { loaded: 1, total: 2 }, { sessionId: null });
      await adapter.model.cancelDownload();
      window.__NATIVE_FAKE__.emit(downloadIndex, "model.progress", { loaded: 2, total: 2 }, { sessionId: null });
      window.__NATIVE_FAKE__.emit(downloadIndex, "error", { code: "LATE_MODEL_ERROR", message: "ignore me" }, { sessionId: null });
      window.__NATIVE_FAKE__.emit(downloadIndex, "future.event", { anything: true }, { sessionId: null });
      window.__NATIVE_FAKE__.emit(downloadIndex, "model.progress", { loaded: 5, total: 2 }, { sessionId: null });
      window.__NATIVE_FAKE__.emit(downloadIndex, "error", { code: 12, message: "wrong type" }, { sessionId: null });
      return seen;
    });
    expect(result).toEqual([["progress", 1]]);
  });

  test("never accepts or transports PCM payloads", async ({ page }) => {
    await installFakeBridge(page);
    await createAdapter(page);
    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      await adapter.tts.start();
      const before = window.__NATIVE_FAKE__.messages.length;
      let outbound;
      try { await adapter.tts.enqueue("Valid text", { pcm: new Float32Array([0.1]) }); }
      catch (error) { outbound = { name: error.name, code: error.code }; }

      window.__NATIVE_FAKE__.autoReply = false;
      const pending = adapter.model.status().then(
        () => ({ resolved: true }),
        error => ({ name: error.name, code: error.code })
      );
      const index = window.__NATIVE_FAKE__.messages.length - 1;
      window.__NATIVE_FAKE__.reply(index, { result: { pcm: new Float32Array([0.2]) } });
      return {
        outbound,
        outboundPosts: index - before,
        inbound: await pending,
        messages: window.__NATIVE_FAKE__.messages,
      };
    });
    expect(result.outbound).toEqual({ name: "NativeTTSProtocolError", code: "PROTOCOL_ERROR" });
    expect(result.outboundPosts).toBe(0);
    expect(result.inbound).toEqual({ name: "NativeTTSProtocolError", code: "PROTOCOL_ERROR" });
    expect(JSON.stringify(result.messages)).not.toMatch(/"(?:pcm|samples|audio|audioData|audioBuffer)"/i);
  });

  test("unsubscribe and dispose remove listeners, receiver, and pending requests", async ({ page }) => {
    await installFakeBridge(page, { autoReply: false });
    await createAdapter(page);
    const pending = page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      let calls = 0;
      const off = adapter.on("model.progress", () => calls++);
      off();
      window.__NATIVE_PENDING_RESULT__ = adapter.model.status().then(
        () => ({ resolved: true }),
        error => ({ name: error.name, code: error.code })
      );
      return true;
    });
    await pending;
    await waitForMessages(page, 1);
    const result = await page.evaluate(async () => {
      const adapter = window.__NATIVE_ADAPTER__;
      const request = window.__NATIVE_FAKE__.messages[0];
      const receiver = request.eventReceiver;
      adapter.dispose();
      adapter.dispose(); // idempotent
      return {
        pending: await window.__NATIVE_PENDING_RESULT__,
        receiverExists: typeof window[receiver] === "function",
        available: adapter.available,
        lateDelivered: window.__NATIVE_FAKE__.reply(0),
      };
    });
    expect(result).toEqual({
      pending: { name: "NativeTTSDisposedError", code: "BRIDGE_DISPOSED" },
      receiverExists: false,
      available: false,
      lateDelivered: true,
    });
  });
});
