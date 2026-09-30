package com.videocall.mobile.ui.util

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/** Records a voice message to an AAC .m4a file in the cache directory. */
class VoiceRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L

    val isRecording: Boolean get() = recorder != null

    fun start(): Boolean {
        if (recorder != null) return true
        val dir = File(context.cacheDir, "voice").apply { mkdirs() }
        val out = File(dir, "voice-message-${System.currentTimeMillis()}.m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(64_000)
            r.setAudioSamplingRate(44_100)
            r.setOutputFile(out.path)
            r.prepare()
            r.start()
            recorder = r
            file = out
            startedAt = System.currentTimeMillis()
            true
        } catch (e: Exception) {
            runCatching { r.release() }
            out.delete()
            false
        }
    }

    /** Stops and returns the recording, or null if it was too short to be intentional. */
    fun stop(): File? {
        val r = recorder ?: return null
        recorder = null
        val out = file
        file = null
        val tooShort = System.currentTimeMillis() - startedAt < 700
        val ok = runCatching { r.stop() }.isSuccess
        runCatching { r.release() }
        if (!ok || tooShort) {
            out?.delete()
            return null
        }
        return out
    }

    fun cancel() {
        val r = recorder ?: return
        recorder = null
        runCatching { r.stop() }
        runCatching { r.release() }
        file?.delete()
        file = null
    }
}
