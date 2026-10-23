package io.eem26.cast

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * "Class in progress": keeps the app (and the class page in it) running while
 * someone in a live class switches to another app without sharing the screen.
 * Without it Android may close the app in the background, which dropped the
 * presenter out of the class.
 */
class ClassService : Service() {

    companion object {
        private const val CHANNEL = "class"
        private const val NOTIFICATION_ID = 27

        @Volatile var running = false
            private set

        fun start(ctx: Context) {
            val i = Intent(ctx, ClassService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (_: Exception) {
                // Not allowed right now (e.g. the app is already in the background).
            }
        }

        fun stop(ctx: Context) {
            if (running) ctx.stopService(Intent(ctx, ClassService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Class sound plays on (media playback); the microphone keeps
                // working for someone speaking (microphone, needs the permission).
                var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                }
                startForeground(NOTIFICATION_ID, notification(), type)
            } else {
                startForeground(NOTIFICATION_ID, notification())
            }
            running = true
        } catch (_: Exception) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }

    private fun notification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Live class", NotificationManager.IMPORTANCE_LOW))
        }
        val launch = Intent(this, HomeActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val open = PendingIntent.getActivity(this, 3, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setSmallIcon(android.R.drawable.presence_audio_online)
            .setContentTitle("Live class in progress")
            .setContentText("You’re still in the class. Tap to go back.")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }
}
