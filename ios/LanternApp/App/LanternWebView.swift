import SwiftUI
import WebKit

@MainActor
struct LanternWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    func makeUIView(context: Context) -> WKWebView {
        let contentController = WKUserContentController()
        #if DEBUG
        // SECURITY: Release must not expose this privileged handler while the
        // reader can execute remote CDN code. Enable it in Release only after all
        // scripts are bundled locally and a restrictive CSP blocks remote script.
        contentController.addUserScript(WKUserScript(
            source: Self.bootstrapScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page
        ))
        contentController.addScriptMessageHandler(
            context.coordinator,
            contentWorld: .page,
            name: Coordinator.handlerName
        )
        #endif

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        #if DEBUG
        webView.isInspectable = true
        #endif
        context.coordinator.attach(webView)
        loadLantern(in: webView)
        return webView
    }

    @MainActor
    func updateUIView(_ uiView: WKWebView, context: Context) {}

    @MainActor
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        #if DEBUG
        uiView.configuration.userContentController.removeScriptMessageHandler(
            forName: Coordinator.handlerName,
            contentWorld: .page
        )
        #endif
        coordinator.detach()
    }

    @MainActor
    private func loadLantern(in webView: WKWebView) {
        guard let indexURL = Bundle.main.url(forResource: "index", withExtension: "html") else {
            webView.loadHTMLString(
                "<main><h1>Lantern could not start</h1><p>The bundled reader was not found.</p></main>",
                baseURL: nil
            )
            return
        }
        webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
    }

    private static let bootstrapScript = #"""
    (() => {
      const receive = (event) => {
        window.dispatchEvent(new CustomEvent("lantern-native-event", { detail: event }));
      };
      window.LanternNative = Object.freeze({
        version: 1,
        send(command) {
          return window.webkit.messageHandlers.lantern.postMessage(command);
        },
        _receive: receive
      });
    })();
    """#
}

@MainActor
final class WebViewEventDispatcher: BridgeEventDispatching {
    weak var webView: WKWebView?

    func dispatch(_ event: BridgeEventEnvelope, to receiver: String) {
        guard let webView else { return }
        do {
            let object = try BridgeCodec.jsonObject(event)
            webView.callAsyncJavaScript(
                "const callback = window[receiverName]; if (typeof callback === 'function') callback(event)",
                arguments: ["receiverName": receiver, "event": object],
                in: nil,
                contentWorld: .page
            ) { _ in }
        } catch {
            assertionFailure("Unable to encode a native bridge event: \(error)")
        }
    }
}

@MainActor
final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    static let handlerName = "lantern"

    private let dispatcher: WebViewEventDispatcher
    private let router: BridgeRouter

    override init() {
        let dispatcher = WebViewEventDispatcher()
        self.dispatcher = dispatcher
        router = BridgeRouter(engine: MockLocalTTSEngine(), dispatcher: dispatcher)
        super.init()
        Task { await router.startEventPump() }
    }

    func attach(_ webView: WKWebView) { dispatcher.webView = webView }
    func detach() { dispatcher.webView = nil }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard navigationAction.targetFrame?.isMainFrame == true else {
            decisionHandler(.allow)
            return
        }
        let url = navigationAction.request.url
        decisionHandler(url?.isFileURL == true || url?.scheme == "about" ? .allow : .cancel)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame, message.webView?.url?.isFileURL == true else {
            reply(
                .failure(requestId: requestID(from: message.body), code: .malformedRequest, message: "Commands are accepted only from the bundled main frame"),
                using: replyHandler
            )
            return
        }

        let request: BridgeRequest
        do {
            request = try BridgeCodec.decodeRequest(from: message.body)
        } catch let failure as BridgeFailure {
            reply(.failure(requestId: requestID(from: message.body), code: failure.code, message: failure.message), using: replyHandler)
            return
        } catch {
            reply(.failure(requestId: requestID(from: message.body), code: .malformedRequest, message: "Invalid bridge command"), using: replyHandler)
            return
        }

        Task { @MainActor [router] in
            let response = await router.handle(request)
            reply(response, using: replyHandler)
        }
    }

    private func reply(_ response: BridgeReply, using handler: (Any?, String?) -> Void) {
        if let object = try? BridgeCodec.jsonObject(response) {
            handler(object, nil)
        } else {
            handler([
                "protocol": BridgeCodec.protocolName,
                "version": BridgeCodec.version,
                "type": "reply",
                "requestId": response.requestId,
                "ok": false,
                "error": ["code": BridgeErrorCode.internalError.rawValue, "message": "Could not encode native response"]
            ], nil)
        }
    }

    private func requestID(from body: Any) -> String {
        (body as? [String: Any])?["requestId"] as? String ?? ""
    }
}
