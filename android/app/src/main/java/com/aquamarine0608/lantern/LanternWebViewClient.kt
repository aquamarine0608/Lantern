package com.aquamarine0608.lantern

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Message
import android.webkit.ClientCertRequest
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.core.net.toUri
import androidx.webkit.SafeBrowsingResponseCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

internal class LanternWebViewClient(
    private val assetLoader: WebViewAssetLoader,
    private val speechEndpoint: NativeSpeechEndpoint,
) : WebViewClientCompat() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val match = NativeSpeechRequestParser.classify(request.url)
        return if (match == SpeechEndpointMatch.NOT_ENDPOINT) {
            assetLoader.shouldInterceptRequest(request.url)
        } else {
            // Every request whose decoded path names the native endpoint is answered locally.
            speechEndpoint.intercept(request, match)
        }
    }

    @Deprecated("Legacy WebView callback")
    override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse? {
        val uri = url.toUri()
        val match = NativeSpeechRequestParser.classify(uri)
        return if (match == SpeechEndpointMatch.NOT_ENDPOINT) {
            assetLoader.shouldInterceptRequest(uri)
        } else {
            speechEndpoint.rejectHeaderlessLegacyRequest()
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !LanternWebOrigins.isAllowedAssetNavigation(request.url)

    @Deprecated("Legacy WebView callback")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
        !LanternWebOrigins.isAllowedAssetNavigation(url.toUri())

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        if (!LanternWebOrigins.isAllowedAssetNavigation(url.toUri())) {
            view.stopLoading()
            return
        }
        super.onPageStarted(view, url, favicon)
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
    }

    override fun onReceivedHttpAuthRequest(
        view: WebView,
        handler: HttpAuthHandler,
        host: String,
        realm: String,
    ) {
        handler.cancel()
    }

    override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) {
        request.cancel()
    }

    override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) {
        dontResend.sendToTarget()
    }

    @SuppressLint("RequiresFeature")
    override fun onSafeBrowsingHit(
        view: WebView,
        request: WebResourceRequest,
        threatType: Int,
        callback: SafeBrowsingResponseCompat,
    ) {
        callback.backToSafety(true)
    }
}

/** Denies browser capabilities while retaining a narrowly scoped EPUB document picker. */
internal class LanternWebChromeClient(
    private val openEpub: (ValueCallback<Array<Uri>>) -> Unit,
) : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
        request.deny()
    }

    override fun onPermissionRequestCanceled(request: PermissionRequest) = Unit

    override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback,
    ) {
        callback.invoke(origin, false, false)
    }

    override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message,
    ): Boolean = false

    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean {
        if (fileChooserParams.mode != FileChooserParams.MODE_OPEN || fileChooserParams.isCaptureEnabled) {
            filePathCallback.onReceiveValue(null)
            return true
        }
        openEpub(filePathCallback)
        return true
    }
}
