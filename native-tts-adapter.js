/*
 * Lantern native TTS bridge protocol, version 1.
 *
 * This module deliberately carries control-plane messages only. Native code owns
 * model bytes, generated PCM, playback, and file spooling; none of those buffers
 * cross the WKWebView JavaScript bridge.
 *
 * Native receives requests through:
 *   window.webkit.messageHandlers.lantern.postMessage(request)
 *
 * Command replies are the Promise value returned by WKScriptMessageHandlerWithReply.
 * Every request also includes a unique `eventReceiver` global which native uses
 * only for asynchronous progress/playback events.
 */

export const NATIVE_TTS_PROTOCOL = "lantern.native-tts";
export const NATIVE_TTS_VERSION = 1;

const KNOWN_EVENTS = new Set([
  "model.progress",
  "model.ready",
  "tts.buffering",
  "tts.started",
  "tts.position",
  "tts.ended",
  "reader.sentenceStarted",
  "error",
]);

const PCM_KEYS = /^(?:pcm|samples|audio|audioData|audioBuffer|waveform)$/i;
let clientSequence = 0;

const isPlainObject = value => {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

function assertControlPayload(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new NativeTTSProtocolError(`${label} contains a non-finite number`);
  }
  if (typeof value !== "object") throw new NativeTTSProtocolError(`${label} is not JSON-safe`);
  if (typeof ArrayBuffer !== "undefined" &&
      (value instanceof ArrayBuffer || ArrayBuffer.isView(value)))
    throw new NativeTTSProtocolError(`${label} must not contain PCM or binary data`);
  if (typeof Blob !== "undefined" && value instanceof Blob)
    throw new NativeTTSProtocolError(`${label} must not contain blobs`);
  if (seen.has(value)) throw new NativeTTSProtocolError(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertControlPayload(value[i], `${label}[${i}]`, seen);
  } else {
    if (!isPlainObject(value)) throw new NativeTTSProtocolError(`${label} contains an unsupported object`);
    for (const [key, child] of Object.entries(value)) {
      if (PCM_KEYS.test(key)) throw new NativeTTSProtocolError(`${label} must not contain a ${key} payload`);
      assertControlPayload(child, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function bridgeHandler(target = globalThis) {
  const handler = target && target.webkit && target.webkit.messageHandlers &&
    target.webkit.messageHandlers.lantern;
  return handler && typeof handler.postMessage === "function" ? handler : null;
}

export function isNativeTTSAvailable(target = globalThis) {
  return !!bridgeHandler(target);
}

export function nativeTTSCapability(target = globalThis) {
  return Object.freeze({
    available: isNativeTTSAvailable(target),
    protocol: NATIVE_TTS_PROTOCOL,
    version: NATIVE_TTS_VERSION,
    transportsPCM: false,
  });
}

export class NativeTTSBridgeError extends Error {
  constructor(message, code = "BRIDGE_ERROR", details) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class NativeTTSUnavailableError extends NativeTTSBridgeError {
  constructor() {
    super("Lantern's native TTS bridge is unavailable", "BRIDGE_UNAVAILABLE");
  }
}

export class NativeTTSTimeoutError extends NativeTTSBridgeError {
  constructor(method, timeoutMs) {
    super(`Native TTS request timed out: ${method}`, "BRIDGE_TIMEOUT", { method, timeoutMs });
  }
}

export class NativeTTSAbortError extends NativeTTSBridgeError {
  constructor(method) {
    super(`Native TTS request was cancelled: ${method}`, "ABORTED", { method });
    this.name = "AbortError";
  }
}

export class NativeTTSProtocolError extends NativeTTSBridgeError {
  constructor(message, details) {
    super(message, "PROTOCOL_ERROR", details);
  }
}

export class NativeTTSOperationError extends NativeTTSBridgeError {
  constructor(error, method) {
    super(error.message, error.code, error.details);
    this.method = method;
  }
}

export class NativeTTSDisposedError extends NativeTTSBridgeError {
  constructor() {
    super("The native TTS adapter has been disposed", "BRIDGE_DISPOSED");
  }
}

export class NativeTTSStateError extends NativeTTSBridgeError {
  constructor(message, code = "INVALID_STATE") {
    super(message, code);
  }
}

function validateReply(raw, expectedId, expectedMethod) {
  if (!isPlainObject(raw)) throw new NativeTTSProtocolError("Native reply is not an object");
  assertControlPayload(raw, "native reply");
  if (raw.protocol !== NATIVE_TTS_PROTOCOL || raw.version !== NATIVE_TTS_VERSION || raw.type !== "reply")
    throw new NativeTTSProtocolError("Native reply has the wrong protocol envelope");
  if (raw.requestId !== expectedId) throw new NativeTTSProtocolError("Native reply has the wrong request ID");
  if (typeof raw.ok !== "boolean") throw new NativeTTSProtocolError("Native reply is missing a boolean ok field");
  if (raw.ok) {
    if (raw.result !== undefined && raw.result !== null && !isPlainObject(raw.result))
      throw new NativeTTSProtocolError("Native reply result must be an object or null");
    return raw.result === undefined ? null : raw.result;
  }
  if (!isPlainObject(raw.error) || typeof raw.error.code !== "string" || !raw.error.code ||
      typeof raw.error.message !== "string" || !raw.error.message)
    throw new NativeTTSProtocolError("Native error reply is malformed");
  throw new NativeTTSOperationError(raw.error, expectedMethod);
}

function validEventPayload(name, payload) {
  if (!isPlainObject(payload)) return false;
  const finiteAtLeast = (value, floor) => typeof value === "number" && Number.isFinite(value) && value >= floor;
  switch (name) {
    case "model.progress":
      return finiteAtLeast(payload.loaded, 0) && finiteAtLeast(payload.total, 1) &&
        payload.loaded <= payload.total && (payload.file === undefined || typeof payload.file === "string");
    case "model.ready":
      return typeof payload.modelRevision === "string" && !!payload.modelRevision;
    case "tts.buffering":
      return finiteAtLeast(payload.bufferedSeconds, 0);
    case "tts.started":
      return payload.positionSeconds === undefined || finiteAtLeast(payload.positionSeconds, 0);
    case "tts.position":
      return finiteAtLeast(payload.positionSeconds, 0) &&
        (payload.sentenceId === undefined || typeof payload.sentenceId === "string");
    case "tts.ended":
      return payload.reason === undefined || ["completed", "stopped", "error"].includes(payload.reason);
    case "reader.sentenceStarted":
      return typeof payload.sentenceId === "string" && !!payload.sentenceId &&
        Number.isInteger(payload.index) && payload.index >= 0;
    case "error":
      return typeof payload.code === "string" && !!payload.code &&
        typeof payload.message === "string" && !!payload.message;
    default:
      return false;
  }
}

export class NativeTTSAdapter {
  constructor({ timeoutMs = 10_000, prepareTimeoutMs = 60_000, target = globalThis } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new NativeTTSProtocolError("timeoutMs must be a positive finite number");
    if (!Number.isFinite(prepareTimeoutMs) || prepareTimeoutMs <= 0)
      throw new NativeTTSProtocolError("prepareTimeoutMs must be a positive finite number");
    this._target = target;
    this._timeoutMs = timeoutMs;
    this._prepareTimeoutMs = prepareTimeoutMs;
    this._pending = new Map();
    this._listeners = new Map();
    this._requestSequence = 0;
    this._sessionSequence = 0;
    this._activeSessionId = null;
    this._modelEventRequestId = null;
    this._disposed = false;

    const random = target.crypto && typeof target.crypto.randomUUID === "function"
      ? target.crypto.randomUUID() : `${Date.now()}-${++clientSequence}`;
    this._clientId = String(random);
    const safe = this._clientId.replace(/[^a-zA-Z0-9_]/g, "_");
    this._receiver = `__lanternNativeTTSReceiveV${NATIVE_TTS_VERSION}_${safe}`;
    this._receiveBound = message => this._receive(message);
    Object.defineProperty(target, this._receiver, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: this._receiveBound,
    });

    this.model = Object.freeze({
      status: controls => this._request("model.status", {}, controls),
      // Native acknowledges initiation quickly; progress and completion arrive as events.
      download: (params = {}, controls) => this._request("model.download", params, { ...controls, modelEvents: true }),
      cancelDownload: controls => {
        this._modelEventRequestId = null;
        return this._request("model.cancelDownload", {}, controls);
      },
      delete: controls => {
        this._modelEventRequestId = null;
        return this._request("model.delete", {}, controls);
      },
    });
    this.tts = Object.freeze({
      prepare: (params = {}, controls) => this._prepare(params, controls),
      start: (params = {}, controls) => this._start(params, controls),
      enqueue: (text, params = {}, controls) => this._enqueue(text, params, controls),
      pause: controls => this._sessionRequest("tts.pause", {}, controls),
      resume: controls => this._sessionRequest("tts.resume", {}, controls),
      stop: controls => this._stop(controls),
      setVoice: (voice, controls) => {
        if (typeof voice !== "string" || !voice.trim())
          return Promise.reject(new NativeTTSProtocolError("voice must be a non-empty string"));
        return this._request("tts.setVoice", { voice: voice.trim() }, controls);
      },
      setSpeed: (speed, controls) => {
        if (!Number.isFinite(speed) || speed <= 0)
          return Promise.reject(new NativeTTSProtocolError("speed must be a positive finite number"));
        return this._request("tts.setSpeed", { speed }, controls);
      },
    });
  }

  get available() { return !this._disposed && isNativeTTSAvailable(this._target); }
  get capability() { return nativeTTSCapability(this._target); }
  get activeSessionId() { return this._activeSessionId; }

  on(eventName, listener) {
    if (!KNOWN_EVENTS.has(eventName)) throw new NativeTTSProtocolError(`Unknown native event: ${eventName}`);
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    let set = this._listeners.get(eventName);
    if (!set) this._listeners.set(eventName, set = new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this._listeners.delete(eventName);
    };
  }

  _emit(eventName, detail) {
    const listeners = this._listeners.get(eventName);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(detail); }
      catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  _nextRequestId() { return `${this._clientId}:request:${++this._requestSequence}`; }
  _nextSessionId() { return `${this._clientId}:session:${++this._sessionSequence}`; }

  _request(method, params = {}, controls = {}) {
    if (this._disposed) return Promise.reject(new NativeTTSDisposedError());
    const handler = bridgeHandler(this._target);
    if (!handler) return Promise.reject(new NativeTTSUnavailableError());
    if (!isPlainObject(params)) return Promise.reject(new NativeTTSProtocolError(`${method} params must be an object`));
    try { assertControlPayload(params, `${method} params`); }
    catch (error) { return Promise.reject(error); }

    controls = controls || {};
    const signal = controls.signal;
    const timeoutMs = controls.timeoutMs === undefined ? this._timeoutMs : controls.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      return Promise.reject(new NativeTTSProtocolError("timeoutMs must be a positive finite number"));
    if (signal && signal.aborted) return Promise.reject(new NativeTTSAbortError(method));

    const requestId = this._nextRequestId();
    const sessionId = controls.sessionId === undefined ? null : controls.sessionId;
    if (sessionId !== null && (typeof sessionId !== "string" || !sessionId))
      return Promise.reject(new NativeTTSProtocolError("sessionId must be a non-empty string or null"));
    if (controls.modelEvents) this._modelEventRequestId = requestId;

    const message = {
      protocol: NATIVE_TTS_PROTOCOL,
      version: NATIVE_TTS_VERSION,
      type: "request",
      requestId,
      method,
      sessionId,
      params,
      eventReceiver: this._receiver,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        this._pending.delete(requestId);
        fn(value);
      };
      const fail = error => {
        if (this._modelEventRequestId === requestId) this._modelEventRequestId = null;
        finish(reject, error);
      };
      const onAbort = () => fail(new NativeTTSAbortError(method));
      const timer = setTimeout(() => fail(new NativeTTSTimeoutError(method, timeoutMs)), timeoutMs);
      this._pending.set(requestId, {
        method,
        resolve: value => finish(resolve, value),
        reject: fail,
      });
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        // Close the small race between the preflight check and listener setup.
        if (signal.aborted) {
          onAbort();
          return;
        }
      }
      try {
        const replyPromise = handler.postMessage(message);
        if (!replyPromise || typeof replyPromise.then !== "function") {
          fail(new NativeTTSProtocolError(`${method} did not return a reply Promise`));
          return;
        }
        replyPromise.then(raw => {
          const pending = this._pending.get(requestId);
          if (!pending) return; // timed out, aborted, disposed, or otherwise superseded
          try { pending.resolve(validateReply(raw, requestId, method)); }
          catch (error) { pending.reject(error); }
        }, error => {
          const pending = this._pending.get(requestId);
          if (!pending) return;
          pending.reject(new NativeTTSBridgeError(
            `Native TTS reply Promise rejected: ${method}`,
            "NATIVE_REPLY_REJECTED",
            { method, cause: String(error && error.message || error) }
          ));
        });
      }
      catch (error) {
        fail(new NativeTTSBridgeError(`Could not post native TTS request: ${method}`, "POST_FAILED", { cause: String(error) }));
      }
    });
  }

  _prepare(params, controls) {
    const requestControls = { ...(controls || {}), modelEvents: true };
    if (requestControls.timeoutMs === undefined) requestControls.timeoutMs = this._prepareTimeoutMs;
    return this._request("tts.prepare", params, requestControls);
  }

  async _start(params, controls) {
    if (!isPlainObject(params)) throw new NativeTTSProtocolError("tts.start params must be an object");
    const previousSessionId = this._activeSessionId;
    const sessionId = this._nextSessionId();
    this._activeSessionId = sessionId; // fences the preceding session before native work begins
    try {
      const result = await this._request("tts.start", params, { ...(controls || {}), sessionId });
      if (this._activeSessionId !== sessionId)
        throw new NativeTTSStateError("The native TTS session was superseded", "SESSION_SUPERSEDED");
      return { sessionId, result };
    } catch (error) {
      if (this._activeSessionId === sessionId) this._activeSessionId = previousSessionId;
      throw error;
    }
  }

  _enqueue(text, params, controls) {
    if (typeof text !== "string" || !text.trim())
      return Promise.reject(new NativeTTSProtocolError("tts.enqueue text must be a non-empty string"));
    if (!isPlainObject(params)) return Promise.reject(new NativeTTSProtocolError("tts.enqueue params must be an object"));
    return this._sessionRequest("tts.enqueue", { ...params, text }, controls);
  }

  _sessionRequest(method, params, controls) {
    if (!this._activeSessionId)
      return Promise.reject(new NativeTTSStateError("There is no active native TTS session", "NO_ACTIVE_SESSION"));
    return this._request(method, params, { ...(controls || {}), sessionId: this._activeSessionId });
  }

  _stop(controls) {
    if (!this._activeSessionId)
      return Promise.reject(new NativeTTSStateError("There is no active native TTS session", "NO_ACTIVE_SESSION"));
    const sessionId = this._activeSessionId;
    return this._request("tts.stop", {}, { ...(controls || {}), sessionId }).then(result => {
      // A superseding start owns the new ID; a late stop reply must not clear it.
      if (this._activeSessionId === sessionId) this._activeSessionId = null;
      return result;
    });
  }

  _receive(raw) {
    if (this._disposed || !isPlainObject(raw)) return;
    const requestId = typeof raw.requestId === "string" ? raw.requestId : null;

    if (raw.type !== "event" || raw.protocol !== NATIVE_TTS_PROTOCOL ||
        raw.version !== NATIVE_TTS_VERSION || typeof raw.event !== "string" ||
        !KNOWN_EVENTS.has(raw.event)) return;
    try { assertControlPayload(raw, "native event"); }
    catch { return; }
    if (!validEventPayload(raw.event, raw.payload)) return;

    const hasSession = raw.sessionId !== undefined && raw.sessionId !== null;
    const isModel = raw.event === "model.progress" || raw.event === "model.ready";
    const isModelError = raw.event === "error" && !hasSession;
    const isSession = raw.event.startsWith("tts.") || raw.event === "reader.sentenceStarted";
    if ((isModel || isModelError) && (!requestId || requestId !== this._modelEventRequestId)) return;
    if (isSession && (typeof raw.sessionId !== "string" || raw.sessionId !== this._activeSessionId)) return;
    if (raw.event === "error" && hasSession &&
        raw.sessionId !== this._activeSessionId) return;

    const detail = Object.freeze({
      event: raw.event,
      requestId,
      sessionId: raw.sessionId === undefined ? null : raw.sessionId,
      payload: raw.payload,
    });
    this._emit(raw.event, detail);
    if (raw.event === "model.ready" && this._modelEventRequestId === requestId)
      this._modelEventRequestId = null;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const error = new NativeTTSDisposedError();
    for (const pending of [...this._pending.values()]) pending.reject(error);
    this._pending.clear();
    this._listeners.clear();
    this._activeSessionId = null;
    this._modelEventRequestId = null;
    if (this._target[this._receiver] === this._receiveBound) {
      try { delete this._target[this._receiver]; } catch {}
    }
  }
}

export function createNativeTTSAdapter(options) {
  return new NativeTTSAdapter(options);
}
