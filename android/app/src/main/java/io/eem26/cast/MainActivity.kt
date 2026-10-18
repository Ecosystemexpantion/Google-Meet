package io.eem26.cast

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * One screen: opened from the presenter studio (eem26cast://cast?api=…&token=…&room=…),
 * it asks Android for screen-capture permission and starts [CastService].
 */
class MainActivity : Activity() {

    private companion object {
        const val REQ_CAPTURE = 1
        const val REQ_PERMS = 2
        const val PREFS = "cast"
    }

    private lateinit var status: TextView
    private lateinit var room: TextView
    private lateinit var micBox: CheckBox
    private lateinit var startBtn: Button
    private lateinit var stopBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        CastService.listener = { refresh() }
        refresh()
    }

    override fun onPause() {
        CastService.listener = null
        super.onPause()
    }

    /** Store the class details handed over by the presenter studio. */
    private fun handleLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme != "eem26cast") return
        val api = data.getQueryParameter("api")
        val token = data.getQueryParameter("token")
        if (api.isNullOrEmpty() || token.isNullOrEmpty() || !api.startsWith("https://")) {
            Toast.makeText(this, "That link is incomplete. Open EEM26 Live from the presenter studio.", Toast.LENGTH_LONG).show()
            return
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("api", api)
            .putString("token", token)
            .putString("room", data.getQueryParameter("room") ?: "")
            .putLong("at", System.currentTimeMillis())
            .apply()
        refresh()
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun linked(): Boolean {
        val p = prefs()
        // Presenter tokens last 12 hours; ask for a fresh link after that.
        return !p.getString("token", null).isNullOrEmpty() && System.currentTimeMillis() - p.getLong("at", 0) < 11 * 3600_000L
    }

    private fun refresh() {
        val live = CastService.running
        val roomName = prefs().getString("room", "") ?: ""
        room.text = if (linked()) "Class: ${roomName.ifEmpty { "connected" }}" else "Not connected to a class yet"
        status.text = when {
            live -> CastService.status
            !linked() -> "In the presenter studio, tap Share screen → Open EEM26 Live."
            else -> CastService.status.takeIf { it != "Ready" } ?: "Ready to share your screen."
        }
        startBtn.isEnabled = linked() && !live
        stopBtn.isEnabled = live
        micBox.isEnabled = !live
    }

    private fun startSharing() {
        val needed = mutableListOf<String>()
        if (micBox.isChecked && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.RECORD_AUDIO
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), REQ_PERMS)
            return
        }
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMS) return
        val micDenied = permissions.indices.any { permissions[it] == Manifest.permission.RECORD_AUDIO && grantResults[it] != PackageManager.PERMISSION_GRANTED }
        if (micDenied) {
            micBox.isChecked = false
            Toast.makeText(this, "Sharing without your microphone.", Toast.LENGTH_SHORT).show()
        }
        val mpm = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), REQ_CAPTURE)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_CAPTURE) return
        if (resultCode != RESULT_OK || data == null) {
            Toast.makeText(this, "Screen sharing wasn’t allowed.", Toast.LENGTH_SHORT).show()
            return
        }
        val p = prefs()
        val svc = Intent(this, CastService::class.java)
            .setAction(CastService.ACTION_START)
            .putExtra(CastService.EXTRA_RESULT_CODE, resultCode)
            .putExtra(CastService.EXTRA_RESULT_DATA, data)
            .putExtra(CastService.EXTRA_API, p.getString("api", ""))
            .putExtra(CastService.EXTRA_TOKEN, p.getString("token", ""))
            .putExtra(CastService.EXTRA_MIC, micBox.isChecked)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc) else startService(svc)
        status.text = "Connecting…"
        startBtn.isEnabled = false
        Toast.makeText(this, "You can switch to any app now — your screen stays shared.", Toast.LENGTH_LONG).show()
    }

    private fun stopSharing() {
        startService(Intent(this, CastService::class.java).setAction(CastService.ACTION_STOP))
    }

    // ── UI (built in code: one screen, no layouts) ──
    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = size
        setTextColor(color)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun button(label: String, fill: Int, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 17f
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(fill) }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(54)).apply { topMargin = dp(12) }
    }

    private fun buildUi() {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(40), dp(24), dp(32))
        }
        val chip = text("EEM26", 14f, Color.WHITE, bold = true).apply {
            background = GradientDrawable().apply { cornerRadius = dp(6).toFloat(); setColor(Color.parseColor("#7C5CE0")) }
            setPadding(dp(10), dp(4), dp(10), dp(4))
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT)
        }
        col.addView(chip)
        col.addView(text("EEM26 Live", 28f, Color.WHITE, bold = true))
        col.addView(text("Share your phone screen with everyone in your live class.", 16f, Color.parseColor("#9AA0AD")))
        room = text("", 15f, Color.parseColor("#C9CCD4"))
        col.addView(room)
        status = text("", 18f, Color.parseColor("#E9E3FF"), bold = true).apply {
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(Color.parseColor("#1E2027")) }
            setPadding(dp(16), dp(14), dp(16), dp(14))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) }
        }
        col.addView(status)
        micBox = CheckBox(this).apply {
            text = "Share my microphone too"
            isChecked = true
            textSize = 16f
            setTextColor(Color.WHITE)
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) }
        }
        col.addView(micBox)
        startBtn = button("Start sharing", Color.parseColor("#7C5CE0")) { startSharing() }
        stopBtn = button("Stop sharing", Color.parseColor("#EF4444")) { stopSharing() }
        col.addView(startBtn)
        col.addView(stopBtn)
        col.addView(text(
            "Tip: after you start, switch to any app — the class sees exactly what’s on your screen. " +
                "Notifications can show too, so turn on Do Not Disturb before you present.",
            14f, Color.parseColor("#6B7180")).apply { gravity = Gravity.START; setPadding(0, dp(20), 0, 0) })
        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#0E0F12"))
            addView(col)
        })
    }
}
