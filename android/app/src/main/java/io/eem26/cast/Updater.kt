package io.eem26.cast

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates. The class itself is the website, so it is always current;
 * only the app shell (screen capture, microphone) needs a new version now and
 * then. On launch this checks app/version.json on the site and, when a newer
 * build is published, offers to download it and open Android's installer.
 */
object Updater {
    private const val VERSION_URL = StudioActivity.SITE + "app/version.json"
    private const val APK_URL = StudioActivity.SITE + "app/eem26-live.apk"
    private var askedThisLaunch = false

    fun check(activity: Activity) {
        if (askedThisLaunch || CastService.running) return
        Thread {
            val latest = try {
                val conn = URL("$VERSION_URL?t=${System.currentTimeMillis()}").openConnection() as HttpURLConnection
                conn.connectTimeout = 8_000
                conn.readTimeout = 8_000
                conn.useCaches = false
                try { JSONObject(conn.inputStream.bufferedReader().readText()) } finally { conn.disconnect() }
            } catch (_: Exception) {
                return@Thread
            }
            val code = latest.optLong("versionCode")
            if (code <= installedCode(activity)) return@Thread
            activity.runOnUiThread {
                if (activity.isFinishing || askedThisLaunch || CastService.running) return@runOnUiThread
                askedThisLaunch = true
                AlertDialog.Builder(activity)
                    .setTitle("Update available")
                    .setMessage("EEM26 Live ${latest.optString("versionName")} is ready. It takes about a minute and keeps your settings.")
                    .setPositiveButton("Update now") { _, _ -> download(activity, code) }
                    .setNegativeButton("Later", null)
                    .show()
            }
        }.start()
    }

    @Suppress("DEPRECATION")
    private fun installedCode(ctx: Context): Long {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }

    private fun download(activity: Activity, code: Long) {
        val app = activity.applicationContext
        val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val request = DownloadManager.Request(Uri.parse("$APK_URL?v=$code"))
            .setTitle("EEM26 Live update")
            .setMimeType("application/vnd.android.package-archive")
            .setDestinationInExternalFilesDir(app, Environment.DIRECTORY_DOWNLOADS, "eem26-live-$code.apk")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
        val id = dm.enqueue(request)
        Toast.makeText(activity, "Downloading the update…", Toast.LENGTH_SHORT).show()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return
                app.unregisterReceiver(this)
                val uri = dm.getUriForDownloadedFile(id)
                if (uri == null) {
                    Toast.makeText(app, "The update didn’t download. Try again later.", Toast.LENGTH_LONG).show()
                    return
                }
                // Android asks once to allow installs from EEM26 Live, then shows the installer.
                val install = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                try { app.startActivity(install) } catch (_: Exception) {
                    Toast.makeText(app, "Open the downloaded update from your notifications to install it.", Toast.LENGTH_LONG).show()
                }
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") app.registerReceiver(receiver, filter)
    }
}
