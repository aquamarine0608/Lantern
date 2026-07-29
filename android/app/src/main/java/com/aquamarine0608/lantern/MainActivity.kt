package com.aquamarine0608.lantern

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.aquamarine0608.lantern.runtime.QwenNativeRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/** Secure Android host for Lantern's bundled web UI and local Qwen control/data planes. */
class MainActivity : ComponentActivity() {
    private val hostJob = SupervisorJob()
    private val hostScope = CoroutineScope(hostJob + Dispatchers.Main.immediate)
    private val appOwner: LanternApplication by lazy(LazyThreadSafetyMode.NONE) {
        application as LanternApplication
    }
    private val runtime: QwenNativeRuntime by lazy(LazyThreadSafetyMode.NONE) {
        appOwner.qwenRuntime
    }

    private var webView: WebView? = null
    private var messageBridge: NativeWebMessageBridge? = null
    private var synthesisSession: NativeSynthesisSession? = null
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null

    private val epubPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val callback = pendingFileChooser
        pendingFileChooser = null
        callback?.onReceiveValue(uri?.let { arrayOf(it) })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showUnsupportedWebView()
            return
        }
        synthesisSession = appOwner.openSynthesisSession()
        installSecureWebView(savedInstanceState?.getBundle(WEB_VIEW_STATE_KEY))
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    @Suppress("DEPRECATION")
    private fun installSecureWebView(savedWebViewState: Bundle?) {
        WebView.setWebContentsDebuggingEnabled(false)

        val runtimeView = WebView(this)
        webView = runtimeView
        runtimeView.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        runtimeView.importantForAutofill = WebView.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        runtimeView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true

            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false

            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            blockNetworkLoads = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            saveFormData = false
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) {
            WebSettingsCompat.setSafeBrowsingEnabled(runtimeView.settings, true)
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(false)
            setAcceptThirdPartyCookies(runtimeView, false)
        }
        runtimeView.setDownloadListener { _, _, _, _, _ -> Unit }

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(LanternWebOrigins.APP_ASSET_HOST)
            .setHttpAllowed(false)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        val localSynthesisSession = checkNotNull(synthesisSession)
        runtimeView.webViewClient = LanternWebViewClient(
            assetLoader = assetLoader,
            speechEndpoint = NativeSpeechEndpoint(runtime, localSynthesisSession),
        )
        runtimeView.webChromeClient = LanternWebChromeClient(::openEpubPicker)

        val bridge = NativeWebMessageBridge(
            installer = appOwner.qwenModelInstaller,
            scope = hostScope,
            runtime = runtime,
            synthesisSession = localSynthesisSession,
            maintenanceMutex = appOwner.qwenMaintenanceMutex,
        )
        messageBridge = bridge
        WebViewCompat.addWebMessageListener(
            runtimeView,
            NATIVE_HOST_OBJECT,
            setOf(LanternWebOrigins.APP_ORIGIN),
            bridge,
        )

        setContentView(runtimeView)
        val restoredHistory = savedWebViewState?.let(runtimeView::restoreState)
        if (restoredHistory == null || !restoredHistory.isEntirelyLocal()) {
            runtimeView.stopLoading()
            runtimeView.clearHistory()
            runtimeView.loadUrl(LanternWebOrigins.START_URL)
        }
        installBackHandler(runtimeView)
    }

    private fun installBackHandler(runtimeView: WebView) {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val history = runtimeView.copyBackForwardList()
                    val targetIndex = history.currentIndex - 1
                    val currentIsLocal = history.currentIndex in 0 until history.size &&
                        history.getItemAtIndex(history.currentIndex).isLocal()
                    val targetIsLocal = targetIndex in 0 until history.size &&
                        history.getItemAtIndex(targetIndex).isLocal()
                    if (runtimeView.canGoBack() && currentIsLocal && targetIsLocal) {
                        runtimeView.goBack()
                    } else {
                        finish()
                    }
                }
            },
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView?.let { view ->
            val webState = Bundle()
            view.saveState(webState)
            outState.putBundle(WEB_VIEW_STATE_KEY, webState)
        }
        super.onSaveInstanceState(outState)
    }

    private fun openEpubPicker(callback: ValueCallback<Array<Uri>>) {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = callback
        try {
            epubPicker.launch(arrayOf(EPUB_MIME_TYPE))
        } catch (_: RuntimeException) {
            pendingFileChooser = null
            callback.onReceiveValue(null)
        }
    }

    private fun showUnsupportedWebView() {
        setContentView(
            TextView(this).apply {
                text = getString(R.string.unsupported_webview)
                setPadding(48, 48, 48, 48)
            }
        )
    }

    override fun onDestroy() {
        pendingFileChooser?.onReceiveValue(null)
        pendingFileChooser = null

        messageBridge?.close()
        messageBridge = null
        synthesisSession?.close()
        synthesisSession = null
        webView?.let { view ->
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(view, NATIVE_HOST_OBJECT)
            }
            view.stopLoading()
            view.removeAllViews()
            view.destroy()
        }
        webView = null
        hostScope.cancel()
        super.onDestroy()
    }

    private companion object {
        const val NATIVE_HOST_OBJECT = "LanternNativeHost"
        const val EPUB_MIME_TYPE = "application/epub+zip"
        const val WEB_VIEW_STATE_KEY = "lantern.webViewState"
    }
}

private fun android.webkit.WebBackForwardList.isEntirelyLocal(): Boolean {
    if (size <= 0 || currentIndex !in 0 until size) return false
    for (index in 0 until size) {
        if (!getItemAtIndex(index).isLocal()) return false
    }
    return true
}

private fun android.webkit.WebHistoryItem.isLocal(): Boolean {
    val current = url?.let(Uri::parse) ?: return false
    val original = originalUrl?.let(Uri::parse) ?: return false
    return LanternWebOrigins.isAllowedAssetNavigation(current) &&
        LanternWebOrigins.isAllowedAssetNavigation(original)
}
