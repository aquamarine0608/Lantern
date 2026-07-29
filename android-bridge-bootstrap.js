/* Android WebMessage transport for Lantern's versioned native TTS protocol. */
(() => {
  "use strict";

  const target = globalThis;
  const host = target.LanternNativeHost;
  if (target.LanternNative || !host || typeof host.postMessage !== "function") return;

  const pending = new Map();
  const receivers = new Map();
  const MAX_TRACKED_REQUESTS = 256;

  const forgetOldestReceiver = () => {
    if (receivers.size < MAX_TRACKED_REQUESTS) return;
    const oldest = receivers.keys().next().value;
    if (oldest !== undefined) receivers.delete(oldest);
  };

  host.onmessage = messageEvent => {
    let message;
    try {
      message = JSON.parse(String(messageEvent && messageEvent.data));
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) return;

    if (message.type === "reply") {
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      const acceptedForEvents = message.ok === true &&
        !(message.result && message.result.accepted === false);
      if (!request.keepReceiver || !acceptedForEvents) receivers.delete(requestId);
      request.resolve(message);
      return;
    }

    if (message.type !== "event") return;
    const receiverName = receivers.get(requestId);
    const receiver = receiverName && target[receiverName];
    if (typeof receiver === "function") receiver(message);
    if (message.event === "model.ready" || message.event === "tts.ended" || message.event === "error") {
      receivers.delete(requestId);
    }
  };

  const native = Object.freeze({
    version: 1,
    platform: "android",
    send(request) {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        return Promise.reject(new TypeError("Native request must be an object"));
      }
      const requestId = request.requestId;
      if (typeof requestId !== "string" || !requestId || pending.has(requestId)) {
        return Promise.reject(new TypeError("Native request ID is missing or duplicated"));
      }
      if (typeof request.eventReceiver === "string" && request.eventReceiver) {
        if (request.method === "model.download") {
          forgetOldestReceiver();
          receivers.set(requestId, request.eventReceiver);
        }
      }
      if (request.method === "model.cancelDownload" || request.method === "model.delete")
        receivers.clear();
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject, keepReceiver: request.method === "model.download" });
        try {
          host.postMessage(JSON.stringify(request));
        } catch (error) {
          pending.delete(requestId);
          receivers.delete(requestId);
          reject(error);
        }
      });
    },
  });

  Object.defineProperty(target, "LanternNative", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: native,
  });
})();
