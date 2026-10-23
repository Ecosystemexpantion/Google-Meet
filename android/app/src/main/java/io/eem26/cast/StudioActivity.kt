package io.eem26.cast

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.io.File

/**
 * The class website (presenter studio or attendee room) inside the app, with
 * native extras exposed to the page as `window.EEM26App`:
 *  - startShare / stopShare: share the phone screen via [CastService]
 *  - saveText: save the chat transcript to Downloads
 *  - startRecording / stopRecording: record the presenter's share to Movies/EEM26
 *  - classLive: keeps the app running in the background during a class
 *    ([ClassService]) and brings the person back into it if Android closed it
 *
 * Unlike a Chrome tab, this page keeps running while the presenter shows
 * other apps (the screen-sharing foreground service keeps the app alive and
 * the WebView is never paused), so chat and class controls keep working.
 */
class StudioActivity : Activity() {

    companion object {
        const val EXTRA_PAGE = "page"
        /** Reopen this exact page (back into a class Android closed in the background). */
        const val EXTRA_URL = "url"
        private const val LIVE_MS = 12 * 3600_000L
        const val SITE = "https://ecosystemexpantion.github.io/Google-Meet/"
        const val PAGE_HOST = "host.html"
        const val PAGE_JOIN = "index.html"
        private const val REQ_CAPTURE = 11
        private const val REQ_SHARE_PERMS = 12
        private const val REQ_WEB_PERMS = 13
        private const val PREFS = "studio"

        fun lastPage(ctx: Context): String? = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("page", null)

        /** The class page someone was in (and didn't leave) in the last 12 hours. */
        fun liveUrl(ctx: Context): String? {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val url = p.getString("liveUrl", null) ?: return null
            return if (System.currentTimeMillis() - p.getLong("liveAt", 0) < LIVE_MS && url.startsWith(SITE)) url else null
        }

        private fun setLive(ctx: Context, url: String?) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
                if (url == null) remove("liveUrl") else putString("liveUrl", url).putLong("liveAt", System.currentTimeMillis())
            }.apply()
        }

        /** Attendee pages can't be screenshotted or screen-recorded; the presenter's can (they share it). */
        private fun isPresenterPage(url: String?) = url != null && url.removePrefix(SITE).startsWith("host")
    }

    private lateinit var web: WebView
    private var pendingShare: Triple<String, String, String>? = null
    private var pendingGuest = false
    private var pendingWebPermission: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val page = intent.getStringExtra(EXTRA_PAGE) ?: PAGE_HOST
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("page", page).apply()
        val startUrl = intent.getStringExtra(EXTRA_URL)?.takeIf { it.startsWith(SITE) } ?: (SITE + page)
        protect(startUrl)
        // Other apps (screen recorders) can't capture the class sound.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            (getSystemService(Context.AUDIO_SERVICE) as AudioManager).setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE)
        }

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0E0F12"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString = settings.userAgentString + " EEM26App/2"
            addJavascriptInterface(Bridge(), "EEM26App")
            // Keep the page's process alive while the app is in the background.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
            webViewClient = object : WebViewClient() {
                // Stay in the app for the class site; open everything else in the browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url.toString()
                    if (url.startsWith(SITE)) return false
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                    return true
                }

                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                    protect(url)
                }

                // Android stopped the page in the background: reopen it (the
                // class page then rejoins by itself) instead of closing the app.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    val url = liveUrl(this@StudioActivity) ?: (SITE + page)
                    finish()
                    startActivity(Intent(this@StudioActivity, StudioActivity::class.java).putExtra(EXTRA_PAGE, page).putExtra(EXTRA_URL, url))
                    return true
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread { handleWebPermission(request) }
                }
            }
        }
        setContentView(web)
        // An attendee's phone share: hand the track to the page, which tells the presenter.
        CastService.shareListener = { json -> web.evaluateJavascript("window.__eem26Share && window.__eem26Share(${json ?: "null"})", null) }
        CastService.recListener = { json -> web.evaluateJavascript("window.__eem26Rec && window.__eem26Rec($json)", null) }
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(startUrl)
    }

    private fun protect(url: String?) {
        if (isPresenterPage(url)) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    // Deliberately no web.onPause()/pauseTimers(): the class keeps running
    // while the presenter is in another app.

    override fun onResume() {
        super.onResume()
        Updater.check(this) // not only from the home screen: people stay in the class screen
    }

    override fun onDestroy() {
        CastService.shareListener = null
        CastService.recListener = null
        ClassService.stop(this) // the page is gone; reopening the app brings it back (liveUrl)
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) { web.goBack(); return }
        AlertDialog.Builder(this)
            .setTitle("Leave the class?")
            .setMessage("You can come back any time from the EEM26 Live app.")
            .setPositiveButton("Leave") { _, _ ->
                setLive(this, null)
                @Suppress("DEPRECATION") super.onBackPressed()
            }
            .setNegativeButton("Stay", null)
            .show()
    }

    // ── Microphone / camera for the page ──
    private fun handleWebPermission(request: PermissionRequest) {
        val needed = mutableListOf<String>()
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources &&
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) needed += Manifest.permission.RECORD_AUDIO
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE in request.resources &&
            checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) needed += Manifest.permission.CAMERA
        if (needed.isEmpty()) { request.grant(request.resources); return }
        pendingWebPermission = request
        requestPermissions(needed.toTypedArray(), REQ_WEB_PERMS)
    }

    // ── Screen sharing ──
    private fun beginShare(api: String, token: String, room: String, guest: Boolean = false) {
        if (CastService.running) {
            Toast.makeText(this, "You’re already sharing your screen.", Toast.LENGTH_SHORT).show()
            return
        }
        pendingShare = Triple(api, token, room)
        pendingGuest = guest
        val needed = mutableListOf<String>()
        if (!guest && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) needed += Manifest.permission.RECORD_AUDIO
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        if (needed.isNotEmpty()) requestPermissions(needed.toTypedArray(), REQ_SHARE_PERMS) else askCapture()
    }

    private fun askCapture() {
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_SHARE_PERMS -> askCapture()
            REQ_WEB_PERMS -> {
                val req = pendingWebPermission ?: return
                pendingWebPermission = null
                val granted = req.resources.filter {
                    when (it) {
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                        else -> false
                    }
                }
                if (granted.isEmpty()) req.deny() else req.grant(granted.toTypedArray())
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAPTURE) return
        val share = pendingShare ?: return
        pendingShare = null
        if (resultCode != RESULT_OK || data == null) {
            Toast.makeText(this, "Screen sharing wasn’t allowed.", Toast.LENGTH_SHORT).show()
            return
        }
        // Attendees keep speaking through the class page; only the presenter's app shares the mic.
        val mic = !pendingGuest && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val svc = Intent(this, CastService::class.java)
            .setAction(CastService.ACTION_START)
            .putExtra(CastService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(CastService.EXTRA_RESULT_DATA, data)
            .putExtra(CastService.EXTRA_API, share.first)
            .putExtra(CastService.EXTRA_TOKEN, share.second)
            .putExtra(CastService.EXTRA_MIC, mic)
            .putExtra(CastService.EXTRA_GUEST, pendingGuest)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc) else startService(svc)
        Toast.makeText(this, "Sharing your screen — switch to any app to show it.", Toast.LENGTH_LONG).show()
    }

    // ── Chat transcript ──
    private fun save(name: String, text: String) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                }
                val uri: Uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no storage")
                contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
            } else {
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                File(dir, name).writeText(text)
            }
            Toast.makeText(this, "Saved to Downloads: $name", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Couldn’t save the transcript.", Toast.LENGTH_LONG).show()
        }
    }

    /** Methods the web page can call (window.EEM26App). Called on a WebView thread. */
    inner class Bridge {
        @JavascriptInterface
        fun startShare(api: String, token: String, room: String) {
            if (!api.startsWith("https://")) return
            runOnUiThread { beginShare(api, token, room) }
        }

        @JavascriptInterface
        fun startGuestShare(api: String, token: String) {
            if (!api.startsWith("https://")) return
            runOnUiThread { beginShare(api, token, "", guest = true) }
        }

        @JavascriptInterface
        fun setMicMuted(muted: Boolean) {
            CastService.setMicMuted(muted)
        }

        @JavascriptInterface
        fun stopShare() {
            runOnUiThread {
                if (CastService.running) startService(Intent(this@StudioActivity, CastService::class.java).setAction(CastService.ACTION_STOP))
            }
        }

        @JavascriptInterface
        fun saveText(name: String, text: String) {
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80).ifEmpty { "chat.txt" }
            runOnUiThread { save(safe, text) }
        }

        @JavascriptInterface
        fun isSharing(): Boolean = CastService.running

        /** The page joined (true) or left/ended (false) a live class. */
        @JavascriptInterface
        fun classLive(live: Boolean) {
            runOnUiThread {
                if (live) {
                    setLive(this@StudioActivity, web.url)
                    ClassService.start(this@StudioActivity)
                } else {
                    setLive(this@StudioActivity, null)
                    ClassService.stop(this@StudioActivity)
                }
            }
        }

        @JavascriptInterface
        fun startRecording() {
            val error = CastService.startRecording() ?: return
            val json = org.json.JSONObject().put("on", false).put("error", error)
            runOnUiThread { web.evaluateJavascript("window.__eem26Rec && window.__eem26Rec($json)", null) }
        }

        @JavascriptInterface
        fun stopRecording() = CastService.stopRecording()

        @JavascriptInterface
        fun isRecording(): Boolean = CastService.recording
    }
}
