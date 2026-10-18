package io.eem26.cast

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.ResolutionAdjustment
import org.webrtc.RtpParameters
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SimulcastAlignedVideoEncoderFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Captures the phone screen (and optionally the microphone) and publishes it
 * to Cloudflare Realtime SFU, then keeps telling the class server about it
 * until the presenter stops. Runs as a foreground service so it keeps going
 * while the presenter shows other apps.
 */
class CastService : Service() {

    companion object {
        const val ACTION_START = "io.eem26.cast.START"
        const val ACTION_STOP = "io.eem26.cast.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_API = "api"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_MIC = "mic"
        private const val CHANNEL = "cast"
        private const val NOTIFICATION_ID = 26

        @Volatile var running = false
            private set
        @Volatile var status: String = "Ready"
            private set
        /** Called on the main thread whenever [status] changes. */
        var listener: ((String) -> Unit)? = null
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var stopping = false
    private var worker: Thread? = null

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var helper: SurfaceTextureHelper? = null
    private var pc: PeerConnection? = null
    private var signaling: Signaling? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopCast("Stopped")
            ACTION_START -> if (!running) start(intent)
        }
        return START_NOT_STICKY
    }

    private fun setStatus(s: String) {
        status = s
        main.post { listener?.invoke(s) }
    }

    private fun start(intent: Intent) {
        val mic = intent.getBooleanExtra(EXTRA_MIC, true)
        // Android 14+: the foreground service must be running before the
        // screen capture permission is used.
        var type = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (mic && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification(), type)
        else startForeground(NOTIFICATION_ID, notification())

        running = true
        stopping = false
        setStatus("Connecting…")
        val resultData: Intent? = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_RESULT_DATA)
        val api = intent.getStringExtra(EXTRA_API) ?: ""
        val token = intent.getStringExtra(EXTRA_TOKEN) ?: ""
        if (resultData == null || api.isEmpty() || token.isEmpty()) {
            stopCast("Start sharing again from the presenter studio.")
            return
        }
        worker = Thread {
            try {
                run(resultData, api, token, mic)
            } catch (e: Exception) {
                stopCast("Couldn’t share: ${e.message ?: e.javaClass.simpleName}")
            }
        }.apply { start() }
    }

    private fun run(resultData: Intent, api: String, token: String, mic: Boolean) {
        val ctx = applicationContext
        val sig = Signaling(api, token).also { signaling = it }

        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions())
        val egl = EglBase.create().also { this.egl = it }
        val adm = JavaAudioDeviceModule.builder(ctx)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(
                // One encoder per layer, sized so phone hardware encoders accept it.
                SimulcastAlignedVideoEncoderFactory(egl.eglBaseContext, true, true, ResolutionAdjustment.MULTIPLE_OF_16))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
            .also { this.factory = it }

        // Screen
        val capturer = ScreenCapturerAndroid(resultData, object : MediaProjection.Callback() {
            override fun onStop() {
                stopCast("Screen sharing ended")
            }
        }).also { this.capturer = it }
        val helper = SurfaceTextureHelper.create("CastCapture", egl.eglBaseContext).also { this.helper = it }
        val videoSource = factory.createVideoSource(true)
        capturer.initialize(helper, ctx, videoSource.capturerObserver)
        val (w, h) = captureSize()
        capturer.startCapture(w, h, 15)
        val videoTrack = factory.createVideoTrack("screen", videoSource)
        val audioTrack = if (mic) factory.createAudioTrack("mic", factory.createAudioSource(MediaConstraints())) else null

        // Connection to Cloudflare
        val config = PeerConnection.RTCConfiguration(sig.iceServers()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val pc = factory.createPeerConnection(config, object : PeerObserver() {
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED -> setStatus("Live — everyone can see your screen")
                    PeerConnection.PeerConnectionState.DISCONNECTED -> setStatus("Connection unstable — reconnecting…")
                    PeerConnection.PeerConnectionState.FAILED -> stopCast("Connection lost. Tap Start sharing to try again.")
                    else -> {}
                }
            }
        }) ?: throw IllegalStateException("Could not create connection")
        this.pc = pc

        // Two layers, like the browser share: "f" (full) for computers and good
        // connections, "h" (half size, a quarter of the data) for phones and
        // weak connections. Each viewer only receives the one it needs.
        val full = RtpParameters.Encoding("f", true, 1.0).apply {
            maxBitrateBps = 1_200_000
            maxFramerate = 15
        }
        val half = RtpParameters.Encoding("h", true, 2.0).apply {
            maxBitrateBps = 300_000
            maxFramerate = 10
        }
        val videoTx = pc.addTransceiver(videoTrack, RtpTransceiver.RtpTransceiverInit(
            RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("cast"), listOf(full, half)))
        // Screens are mostly text: keep them sharp and drop frames instead.
        videoTx.sender.parameters.let { p ->
            p.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
            videoTx.sender.parameters = p
        }
        val audioTx = audioTrack?.let {
            pc.addTransceiver(it, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, listOf("cast")))
        }

        sig.newSession()
        val offer = sdp { obs -> pc.createOffer(obs, MediaConstraints()) }
        setSdp { obs -> pc.setLocalDescription(obs, offer) }
        val id = UUID.randomUUID().toString().take(8)
        val screenName = "cast-screen-$id"
        val micName = if (audioTx != null) "cast-mic-$id" else null
        val tracks = mutableListOf(videoTx.mid to screenName)
        if (audioTx != null && micName != null) tracks += audioTx.mid to micName
        val answer = sig.pushTracks(pc.localDescription.description, tracks)
        setSdp { obs -> pc.setRemoteDescription(obs, SessionDescription(SessionDescription.Type.ANSWER, answer)) }
        setStatus("Going live…")

        // Heartbeat: keeps the class showing this share; the presenter studio
        // answers stop=true when "Stop presenting" is pressed.
        var failures = 0
        while (!stopping) {
            try {
                if (sig.heartbeat(screenName, micName)) {
                    stopCast("Stopped from the presenter studio")
                    return
                }
                failures = 0
            } catch (e: Exception) {
                if (++failures >= 6) {
                    stopCast("Lost contact with the class server")
                    return
                }
            }
            try { Thread.sleep(5_000) } catch (e: InterruptedException) { return }
        }
    }

    private fun captureSize(): Pair<Int, Int> {
        val m = resources.displayMetrics
        val scale = minOf(1f, 1280f / max(m.widthPixels, m.heightPixels))
        val w = ((m.widthPixels * scale).roundToInt() / 2) * 2
        val h = ((m.heightPixels * scale).roundToInt() / 2) * 2
        return w to h
    }

    private fun stopCast(reason: String) {
        synchronized(this) {
            if (stopping) return
            stopping = true
        }
        Thread {
            try { signaling?.takeIf { it.sessionId.isNotEmpty() }?.stopped() } catch (_: Exception) {}
            try { capturer?.stopCapture() } catch (_: Exception) {}
            try { capturer?.dispose() } catch (_: Exception) {}
            try { pc?.dispose() } catch (_: Exception) {}
            try { helper?.dispose() } catch (_: Exception) {}
            try { factory?.dispose() } catch (_: Exception) {}
            try { egl?.release() } catch (_: Exception) {}
            capturer = null; pc = null; helper = null; factory = null; egl = null
            worker?.interrupt()
            running = false
            setStatus(reason)
            main.post {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
                else @Suppress("DEPRECATION") stopForeground(true)
                stopSelf()
            }
        }.start()
    }

    private fun notification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val stop = PendingIntent.getService(this, 1, Intent(this, CastService::class.java).setAction(ACTION_STOP), flags)
        // Same as tapping the app icon: brings the class (studio) back to the front.
        val launch = Intent(this, HomeActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        val open = PendingIntent.getActivity(this, 2, launch, flags)
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        return b.setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("Sharing your screen with the class")
            .setContentText("Everyone in the live class can see your screen.")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop sharing", stop).build())
            .build()
    }

    override fun onDestroy() {
        if (!stopping) stopCast("Stopped")
        super.onDestroy()
    }

    // ── SDP helpers (blocking, called on the worker thread) ──
    private fun sdp(op: (SdpObserver) -> Unit): SessionDescription {
        val latch = CountDownLatch(1)
        var result: SessionDescription? = null
        var error: String? = null
        op(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) { result = d; latch.countDown() }
            override fun onCreateFailure(e: String?) { error = e; latch.countDown() }
            override fun onSetSuccess() {}
            override fun onSetFailure(e: String?) {}
        })
        if (!latch.await(15, TimeUnit.SECONDS)) throw IllegalStateException("Timed out creating offer")
        return result ?: throw IllegalStateException(error ?: "Could not create offer")
    }

    private fun setSdp(op: (SdpObserver) -> Unit) {
        val latch = CountDownLatch(1)
        var error: String? = null
        op(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) {}
            override fun onCreateFailure(e: String?) {}
            override fun onSetSuccess() { latch.countDown() }
            override fun onSetFailure(e: String?) { error = e ?: "failed"; latch.countDown() }
        })
        if (!latch.await(15, TimeUnit.SECONDS)) throw IllegalStateException("Timed out applying description")
        error?.let { throw IllegalStateException(it) }
    }
}

/** PeerConnection.Observer with no-op defaults. */
open class PeerObserver : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
    override fun onIceConnectionReceivingChange(receiving: Boolean) {}
    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
    override fun onIceCandidate(candidate: org.webrtc.IceCandidate) {}
    override fun onIceCandidatesRemoved(candidates: Array<out org.webrtc.IceCandidate>) {}
    override fun onAddStream(stream: org.webrtc.MediaStream) {}
    override fun onRemoveStream(stream: org.webrtc.MediaStream) {}
    override fun onDataChannel(channel: org.webrtc.DataChannel) {}
    override fun onRenegotiationNeeded() {}
    override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out org.webrtc.MediaStream>) {}
    override fun onTrack(transceiver: RtpTransceiver) {}
    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {}
}
