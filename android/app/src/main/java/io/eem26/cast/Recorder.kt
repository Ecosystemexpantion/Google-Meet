package io.eem26.cast

import android.content.ContentValues
import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.opengl.GLES20
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import org.webrtc.EglBase
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoFrameDrawer
import org.webrtc.VideoSink
import org.webrtc.audio.JavaAudioDeviceModule
import java.io.File
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * Records what the presenter shares (the screen frames and the presenter's
 * microphone, exactly as sent to the class) into an MP4 in Movies/EEM26.
 * Frames are drawn onto the H.264 encoder's input surface on a private GL
 * thread; the microphone's raw samples are encoded to AAC on the same thread.
 */
class Recorder(
    private val ctx: Context,
    shared: EglBase.Context,
    width: Int,
    height: Int,
    private val withAudio: Boolean,
) : VideoSink {

    /** Where the file ends up, for telling the presenter. */
    val place: String

    private val thread = HandlerThread("Recorder").apply { start() }
    private val handler = Handler(thread.looper)
    private val t0 = System.nanoTime()
    private val vw = width / 16 * 16
    private val vh = height / 16 * 16
    @Volatile private var closed = false
    @Volatile private var lastFrameNs = 0L

    private val muxer: MediaMuxer
    private var uri: Uri? = null
    private var pfd: ParcelFileDescriptor? = null
    private var file: File? = null
    private val video: MediaCodec
    private val inputSurface: android.view.Surface
    private var audio: MediaCodec? = null
    private var audioRate = 0
    private var audioChannels = 0
    private var audioStartUs = -1L
    private var audioFrames = 0L
    private var audioOff = !withAudio

    private var egl: EglBase? = null
    private var drawer: GlRectDrawer? = null
    private var frameDrawer: VideoFrameDrawer? = null

    private var videoIndex = -1
    private var audioIndex = -1
    private var started = false
    private val lastPts = LongArray(2) { -1L }
    private class Pending(val video: Boolean, val data: ByteBuffer, val info: MediaCodec.BufferInfo)
    private val pending = ArrayList<Pending>()

    init {
        val name = "EEM26 class " + SimpleDateFormat("yyyy-MM-dd HH.mm", Locale.US).format(Date()) + ".mp4"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, name)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/EEM26")
                put(MediaStore.Video.Media.IS_PENDING, 1)
            }
            val u = ctx.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("no storage")
            uri = u
            val fd = ctx.contentResolver.openFileDescriptor(u, "rw") ?: throw IllegalStateException("no storage")
            pfd = fd
            muxer = MediaMuxer(fd.fileDescriptor, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            place = "Movies/EEM26/$name"
        } else {
            val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: ctx.filesDir
            val f = File(dir, name).also { file = it }
            muxer = MediaMuxer(f.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            place = f.absolutePath
        }

        val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, vw, vh).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 2_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 15)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
        }
        video = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        try {
            video.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = video.createInputSurface()
            video.start()
            onThread {
                val e = EglBase.create(shared, EglBase.CONFIG_RECORDABLE)
                egl = e
                e.createSurface(inputSurface)
                e.makeCurrent()
                drawer = GlRectDrawer()
                frameDrawer = VideoFrameDrawer()
            }
        } catch (e: Exception) {
            video.release()
            discard()
            thread.quitSafely()
            throw e
        }
    }

    /** Runs [block] on the recorder thread and waits for it, rethrowing its error. */
    private fun onThread(block: () -> Unit) {
        val done = CountDownLatch(1)
        var error: Throwable? = null
        handler.post { try { block() } catch (t: Throwable) { error = t } finally { done.countDown() } }
        if (!done.await(5, TimeUnit.SECONDS)) throw IllegalStateException("recorder not responding")
        error?.let { throw it }
    }

    // ── Screen ──
    override fun onFrame(frame: VideoFrame) {
        if (closed) return
        val now = System.nanoTime()
        if (now - lastFrameNs < 60_000_000L) return // ~15 frames a second is plenty
        lastFrameNs = now
        frame.retain()
        handler.post {
            try { draw(frame, now) } catch (_: Exception) {} finally { frame.release() }
        }
    }

    private fun draw(frame: VideoFrame, atNs: Long) {
        val e = egl ?: return
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        // Fit the frame, keeping its shape (black bars if it turns sideways).
        val fw = frame.rotatedWidth.toFloat()
        val fh = frame.rotatedHeight.toFloat()
        val scale = min(vw / fw, vh / fh)
        val dw = (fw * scale).toInt()
        val dh = (fh * scale).toInt()
        frameDrawer?.drawFrame(frame, drawer, null, (vw - dw) / 2, (vh - dh) / 2, dw, dh)
        e.swapBuffers(atNs - t0)
        drain(video, true, false)
    }

    // ── Voice ──
    /** Called on WebRTC's microphone thread with every 10 ms of sound. */
    fun onAudio(samples: JavaAudioDeviceModule.AudioSamples, muted: Boolean) {
        if (closed || audioOff) return
        val data = if (muted) ByteArray(samples.data.size) else samples.data.copyOf()
        val rate = samples.sampleRate
        val channels = samples.channelCount
        val atUs = (System.nanoTime() - t0) / 1000
        handler.post { try { encodeAudio(data, rate, channels, atUs) } catch (_: Exception) { audioOff = true } }
    }

    private fun encodeAudio(data: ByteArray, rate: Int, channels: Int, atUs: Long) {
        if (audioOff || closed) return
        val codec = audio ?: run {
            val fmt = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 64_000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
            }
            MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).also {
                it.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                it.start()
                audio = it
                audioRate = rate
                audioChannels = channels
                audioStartUs = atUs
            }
        }
        if (rate != audioRate || channels != audioChannels) return
        var off = 0
        while (off < data.size) {
            val i = codec.dequeueInputBuffer(10_000)
            if (i < 0) break
            val buf = codec.getInputBuffer(i) ?: break
            buf.clear()
            val n = min(buf.remaining(), data.size - off)
            buf.put(data, off, n)
            val pts = audioStartUs + audioFrames * 1_000_000L / audioRate
            codec.queueInputBuffer(i, 0, n, pts, 0)
            audioFrames += n / (2 * audioChannels)
            off += n
        }
        drain(codec, false, false)
    }

    // ── File ──
    private fun drain(codec: MediaCodec, isVideo: Boolean, eos: Boolean) {
        val info = MediaCodec.BufferInfo()
        var waits = 0
        while (true) {
            val i = codec.dequeueOutputBuffer(info, if (eos) 10_000 else 0)
            when {
                i == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!eos || ++waits > 100) return
                i == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    if (isVideo) videoIndex = muxer.addTrack(codec.outputFormat)
                    else if (!started) audioIndex = muxer.addTrack(codec.outputFormat)
                    else audioOff = true // too late to add the voice to this file
                    maybeStart()
                }
                i >= 0 -> {
                    val buf = codec.getOutputBuffer(i)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                    if (buf != null && info.size > 0) write(isVideo, buf, info)
                    codec.releaseOutputBuffer(i, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
            }
        }
    }

    private fun maybeStart() {
        if (started || videoIndex < 0) return
        // The voice joins the file if its encoder is ready within a few seconds.
        if (audioIndex < 0 && !audioOff && System.nanoTime() - t0 < 3_000_000_000L) return
        if (audioIndex < 0) audioOff = true
        muxer.start()
        started = true
        for (p in pending) write(p.video, p.data, p.info)
        pending.clear()
    }

    private fun write(isVideo: Boolean, buf: ByteBuffer, info: MediaCodec.BufferInfo) {
        if (!started) {
            maybeStart()
            if (!started) {
                if (pending.size > 600) return
                val copy = ByteBuffer.allocate(info.size)
                buf.position(info.offset); buf.limit(info.offset + info.size)
                copy.put(buf); copy.flip()
                pending += Pending(isVideo, copy, MediaCodec.BufferInfo().apply { set(0, info.size, info.presentationTimeUs, info.flags) })
                return
            }
        }
        val track = if (isVideo) videoIndex else audioIndex
        if (track < 0) return
        val k = if (isVideo) 0 else 1
        // Each track's times must keep increasing.
        if (info.presentationTimeUs <= lastPts[k]) info.presentationTimeUs = lastPts[k] + 1
        lastPts[k] = info.presentationTimeUs
        buf.position(info.offset); buf.limit(info.offset + info.size)
        muxer.writeSampleData(track, buf, info)
    }

    /** Finishes the file; [done] gets where it was saved, or an error. Returns when finished (or after 8 s). */
    fun stop(done: (saved: String?, error: String?) -> Unit) {
        if (closed) return
        closed = true
        val finished = CountDownLatch(1)
        handler.post {
            var error: String? = null
            try {
                try { video.signalEndOfInputStream(); drain(video, true, true) } catch (_: Exception) {}
                audio?.let { a ->
                    try {
                        val i = a.dequeueInputBuffer(10_000)
                        if (i >= 0) a.queueInputBuffer(i, 0, 0, audioStartUs + audioFrames * 1_000_000L / audioRate, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        drain(a, false, true)
                    } catch (_: Exception) {}
                }
                if (!started) maybeStartAnyway()
                if (started) muxer.stop() else error = "Nothing was recorded."
            } catch (e: Exception) {
                error = "The recording couldn’t be saved (${e.message ?: "error"})."
            }
            try { muxer.release() } catch (_: Exception) {}
            for (c in listOfNotNull(video, audio)) { try { c.stop() } catch (_: Exception) {}; try { c.release() } catch (_: Exception) {} }
            try { frameDrawer?.release(); drawer?.release(); egl?.release() } catch (_: Exception) {}
            egl = null
            try { inputSurface.release() } catch (_: Exception) {}
            try { pfd?.close() } catch (_: Exception) {}
            if (error == null) publish() else discard()
            thread.quitSafely()
            done(if (error == null) place else null, error)
            finished.countDown()
        }
        finished.await(8, TimeUnit.SECONDS)
    }

    /** A very short recording: write whatever video there is, without the voice. */
    private fun maybeStartAnyway() {
        if (videoIndex < 0 || pending.isEmpty()) return
        audioOff = true
        muxer.start()
        started = true
        val list = pending.filter { it.video }
        pending.clear()
        for (p in list) write(true, p.data, p.info)
    }

    private fun publish() {
        uri?.let {
            ctx.contentResolver.update(it, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
        }
    }

    private fun discard() {
        try { pfd?.close() } catch (_: Exception) {}
        uri?.let { try { ctx.contentResolver.delete(it, null, null) } catch (_: Exception) {} }
        file?.delete()
    }
}
