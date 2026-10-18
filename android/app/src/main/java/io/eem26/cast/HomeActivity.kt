package io.eem26.cast

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** Launcher screen: start teaching (presenter studio) or join a class. */
class HomeActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Coming back to the app while a class is open: go straight to it.
        if (savedInstanceState == null && StudioActivity.lastPage(this) != null && CastService.running) {
            openStudio(StudioActivity.lastPage(this)!!)
        }
        buildUi()
    }

    override fun onResume() {
        super.onResume()
        Updater.check(this)
    }

    private fun openStudio(page: String) {
        startActivity(Intent(this, StudioActivity::class.java).putExtra(StudioActivity.EXTRA_PAGE, page))
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun button(label: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 17f
        typeface = Typeface.DEFAULT_BOLD
        stateListAnimator = null
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            cornerRadius = dp(14).toFloat()
            if (primary) setColor(Color.parseColor("#7C5CE0"))
            else { setColor(Color.parseColor("#1E2027")); setStroke(dp(1), Color.parseColor("#3A3E4A")) }
        }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, dp(56)).apply { topMargin = dp(12) }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(28), dp(56), dp(28), dp(28))
            setBackgroundColor(Color.parseColor("#0E0F12"))
        }
        root.addView(ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            layoutParams = LinearLayout.LayoutParams(dp(96), dp(96)).apply { topMargin = dp(32) }
            clipToOutline = true
            background = GradientDrawable().apply { cornerRadius = dp(26).toFloat(); setColor(Color.TRANSPARENT) }
        })
        root.addView(TextView(this).apply {
            text = "EEM26 Live"
            textSize = 30f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            setPadding(0, dp(20), 0, 0)
        })
        root.addView(TextView(this).apply {
            text = "Live classes with screen sharing, chat and polls"
            textSize = 15f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#9AA0AD"))
            setPadding(0, dp(6), 0, dp(36))
        })
        val spacer = LinearLayout(this).apply { layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f) }
        root.addView(spacer)
        root.addView(button("Start teaching", true) { openStudio(StudioActivity.PAGE_HOST) })
        root.addView(button("Join a class", false) { openStudio(StudioActivity.PAGE_JOIN) })
        root.addView(TextView(this).apply {
            text = "Presenters sign in with the class password."
            textSize = 13f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#6B7180"))
            layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(18) }
        })
        setContentView(root)
    }
}
