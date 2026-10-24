package com.videocall.mobile.call

import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import com.videocall.mobile.net.IceServer

/**
 * 1:1 peer-to-peer call. Mirrors web/src/lib/webrtc/direct.ts: the caller
 * is the only side that creates offers (incl. ICE restarts), signaling
 * payloads are relayed by the server verbatim via webrtc:relay. Mid-call
 * device switching from the web client isn't ported (mobile has no device
 * picker); screen share is.
 */
class DirectCall(
    private val context: Context,
    private val scope: CoroutineScope,
    val isCaller: Boolean,
    val peerId: Long,
    val callId: String,
    private val relay: (Any) -> Unit,
    val onRemoteVideo: (VideoTrack?) -> Unit,
    val onConnectionState: (PeerConnection.PeerConnectionState) -> Unit,
    val onNetworkQuality: (NetQuality) -> Unit = {},
) {
    private var pc: PeerConnection? = null
    val media = LocalMedia(context)
    private var canOffer = false
    private var makingOffer = false
    private var restartingIce = false
    private val pendingRemoteCandidates = mutableListOf<IceCandidate>()
    private var remoteDescSet = false
    var closed = false
        private set

    private var camSender: RtpSender? = null
    private var remoteVideo: VideoTrack? = null
    private var screenCapture: ScreenCapture? = null
    private var screenSender: RtpSender? = null
    val sharing: Boolean get() = screenCapture != null
    private val netMonitor = NetworkMonitor(scope, { listOf(pc) }, onNetworkQuality)

    fun start(withVideo: Boolean, iceServers: List<IceServer>) {
        WebRtc.ensureInit(context)
        media.start(withVideo)
        val rtcServers = iceServers.map {
            PeerConnection.IceServer.builder(it.urls).apply {
                if (it.username != null) setUsername(it.username)
                if (it.credential != null) setPassword(it.credential)
            }.createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(rtcServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val connection = WebRtc.factory.createPeerConnection(config, object : SimplePcObserver() {
            // WebRTC invokes these directly from its native network_thread via
            // JNI. If a Kotlin exception ever escapes back into native code
            // there, the JNI glue hard-aborts the whole process (fatal signal
            // 6, "Check failed: !env->ExceptionCheck()") — so every callback
            // body must be exception-safe, never just trust the app logic below.
            override fun onIceCandidate(candidate: IceCandidate) {
                try {
                    if (closed) return
                    relay(mapOf("kind" to "candidate", "candidate" to candidateToMap(candidate)))
                } catch (_: Exception) {
                }
            }

            override fun onTrack(transceiver: org.webrtc.RtpTransceiver) {
                try {
                    val track = transceiver.receiver.track()
                    if (track is VideoTrack) {
                        remoteVideo = track
                        onRemoteVideo(track)
                    }
                } catch (_: Exception) {
                }
            }

            // Peer turned their camera off / stopped sharing: drop the frozen frame.
            override fun onRemoveTrack(receiver: RtpReceiver) {
                try {
                    if (receiver.track() === remoteVideo) {
                        remoteVideo = null
                        onRemoteVideo(null)
                    }
                } catch (_: Exception) {
                }
            }

            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                try {
                    if (closed) return
                    onConnectionState(newState)
                    if (newState == PeerConnection.PeerConnectionState.FAILED && canOffer && !restartingIce) {
                        restartingIce = true
                        scope.launch { makeOffer(iceRestart = true); restartingIce = false }
                    }
                } catch (_: Exception) {
                }
            }
        }) ?: return
        pc = connection
        media.audioTrack?.let { connection.addTrack(it, listOf("local")) }
        media.videoTrack?.let { camSender = connection.addTrack(it, listOf("local")) }
        if (isCaller) canOffer = true // caller may offer immediately once accepted
        netMonitor.start()
    }

    /** Callee must wait for its own call:accept to go out before offering. */
    fun enableRenegotiation() {
        canOffer = true
    }

    suspend fun makeOffer(iceRestart: Boolean = false) {
        val conn = pc ?: return
        if (!canOffer || makingOffer || conn.signalingState() != PeerConnection.SignalingState.STABLE) return
        makingOffer = true
        try {
            val constraints = MediaConstraints().apply {
                if (iceRestart) mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
            }
            val offer = conn.createOfferSuspend(constraints)
            conn.setLocalDescriptionSuspend(offer)
            if (!closed) relay(mapOf("kind" to "offer", "sdp" to mapOf("type" to "offer", "sdp" to offer.description)))
        } catch (_: Exception) {
        } finally {
            makingOffer = false
        }
    }

    suspend fun onRelay(data: JsonObject) {
        val conn = pc ?: return
        val kind = (data["kind"] as? JsonPrimitive)?.content ?: return
        try {
            when (kind) {
                "offer" -> {
                    if (conn.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                        conn.setLocalDescriptionSuspend(SessionDescription(SessionDescription.Type.ROLLBACK, ""))
                    }
                    val sdpObj = data["sdp"] as JsonObject
                    val sdpText = (sdpObj["sdp"] as JsonPrimitive).content
                    conn.setRemoteDescriptionSuspend(SessionDescription(SessionDescription.Type.OFFER, sdpText))
                    remoteDescSet = true
                    val answer = conn.createAnswerSuspend(MediaConstraints())
                    conn.setLocalDescriptionSuspend(answer)
                    relay(mapOf("kind" to "answer", "sdp" to mapOf("type" to "answer", "sdp" to answer.description)))
                    flushPending(conn)
                }
                "answer" -> {
                    if (conn.signalingState() == PeerConnection.SignalingState.HAVE_LOCAL_OFFER) {
                        val sdpObj = data["sdp"] as JsonObject
                        val sdpText = (sdpObj["sdp"] as JsonPrimitive).content
                        conn.setRemoteDescriptionSuspend(SessionDescription(SessionDescription.Type.ANSWER, sdpText))
                        remoteDescSet = true
                        flushPending(conn)
                    }
                }
                "candidate" -> {
                    val cObj = data["candidate"] as? JsonObject ?: return
                    val candidate = candidateFromJson(cObj)
                    if (remoteDescSet || conn.remoteDescription != null) conn.addIceCandidate(candidate)
                    else pendingRemoteCandidates.add(candidate)
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun flushPending(conn: PeerConnection) {
        for (c in pendingRemoteCandidates) conn.addIceCandidate(c)
        pendingRemoteCandidates.clear()
    }

    fun setMic(on: Boolean) = media.setMic(on)

    /** Enables/disables the existing camera track, or acquires + publishes one the first time. */
    suspend fun setCam(on: Boolean) {
        val conn = pc ?: return
        if (on && media.videoTrack == null) {
            media.startVideo()
            val track = media.videoTrack ?: return
            camSender = if (screenCapture != null) camSender else conn.addTrack(track, listOf("local"))
            makeOffer()
            return
        }
        media.setCam(on)
    }

    fun switchCamera() = media.switchCamera()

    suspend fun startScreenShare(resultCode: Int, permissionIntent: Intent, onEnded: () -> Unit) {
        val conn = pc ?: return
        if (screenCapture != null) return
        val capture = ScreenCapture(context, resultCode, permissionIntent)
        capture.onEnded = { scope.launch { stopScreenShare(); onEnded() } }
        screenCapture = capture
        try {
            if (camSender != null) {
                camSender!!.setTrack(capture.track, false)
            } else {
                screenSender = conn.addTrack(capture.track, listOf("screen-$callId"))
            }
        } catch (e: Exception) {
            capture.close()
            screenCapture = null
            throw e
        }
        makeOffer()
    }

    suspend fun stopScreenShare() {
        val conn = pc
        val cam = media.videoTrack
        if (camSender != null && cam != null) {
            camSender!!.setTrack(cam, false)
        } else {
            screenSender?.let { runCatching { conn?.removeTrack(it) } }
            screenSender = null
        }
        screenCapture?.close()
        screenCapture = null
        makeOffer()
    }

    fun close() {
        closed = true
        netMonitor.stop()
        pc?.dispose() // close() alone leaks the native connection
        pc = null
        media.close()
        screenCapture?.close()
        screenCapture = null
        screenSender = null
    }
}
