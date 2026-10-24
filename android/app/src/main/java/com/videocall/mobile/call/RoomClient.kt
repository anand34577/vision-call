package com.videocall.mobile.call

import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.RtpSender
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import com.videocall.mobile.net.IceServer

data class RemoteTrackSet(var mic: org.webrtc.AudioTrack? = null, var cam: VideoTrack? = null, var screen: VideoTrack? = null)

/**
 * SFU conference client. Mirrors web/src/lib/webrtc/sfu.ts: a publisher PC
 * (client -> SFU, offers driven by onnegotiationneeded) and a subscriber PC
 * (SFU -> client, offers arrive from the server). Forwarded video/audio
 * tracks are keyed by the publishing user's id (the stream id the SFU
 * assigns) and by track id "mic"/"cam"/"screen" (see server's
 * internal/sfu/participant.go trackKey — it decides "cam" vs "screen" from
 * the sfu:track-state announcement, not from anything in the track itself).
 */
class RoomClient(
    private val context: Context,
    private val scope: CoroutineScope,
    private val send: (String, Map<String, Any?>) -> Unit,
    val onTracksChanged: (Map<Long, RemoteTrackSet>) -> Unit,
    val onConnectionState: (Boolean) -> Unit, // true = connected
    val onNetworkQuality: (NetQuality) -> Unit = {},
) {
    var roomId: String = ""
        private set
    private var pub: PeerConnection? = null
    private var sub: PeerConnection? = null
    val media = LocalMedia(context)
    val remoteTracks = mutableMapOf<Long, RemoteTrackSet>()
    private var makingOffer = false
    private val pendingPubCandidates = mutableListOf<IceCandidate>()
    private val pendingSubCandidates = mutableListOf<IceCandidate>()
    private var pubHasRemote = false
    private var subHasRemote = false
    var closed = false
        private set
    private var iceServers: List<IceServer> = emptyList()
    private var resumePending = false
    private var rejoining = false

    private var camSender: RtpSender? = null
    private var screenCapture: ScreenCapture? = null
    private var screenSender: RtpSender? = null
    val sharing: Boolean get() = screenCapture != null
    private val netMonitor = NetworkMonitor(scope, { listOf(pub, sub) }, onNetworkQuality)

    fun join(roomId: String, video: Boolean, iceServers: List<IceServer>, passcode: String? = null) {
        WebRtc.ensureInit(context)
        this.roomId = roomId
        this.iceServers = iceServers
        media.start(video)
        buildPeers()
        send("room:join", mapOf("room_id" to roomId, "video" to video, "resume" to false, "passcode" to passcode))
        scope.launch { publishOffer() }
        netMonitor.start()
    }

    /** Creates both PeerConnections and attaches whatever local media exists. */
    private fun buildPeers() {
        val rtcServers = iceServers.map {
            PeerConnection.IceServer.builder(it.urls).apply {
                if (it.username != null) setUsername(it.username)
                if (it.credential != null) setPassword(it.credential)
            }.createIceServer()
        }
        val config = { PeerConnection.RTCConfiguration(rtcServers).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN } }

        // These observer callbacks run on WebRTC's native network_thread via JNI —
        // an uncaught Kotlin exception there hard-aborts the whole process
        // (fatal signal 6, "Check failed: !env->ExceptionCheck()"), so every
        // body here must be exception-safe.
        val pubConn = WebRtc.factory.createPeerConnection(config(), object : SimplePcObserver() {
            override fun onIceCandidate(candidate: IceCandidate) {
                try {
                    send("sfu:pub-ice", candidateToMap(candidate))
                } catch (_: Exception) {
                }
            }
            override fun onRenegotiationNeeded() {
                try {
                    scope.launch { publishOffer() }
                } catch (_: Exception) {
                }
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                try {
                    reportState()
                    if (newState == PeerConnection.PeerConnectionState.FAILED) {
                        onConnectionState(false)
                        scope.launch { rejoin() }
                    }
                } catch (_: Exception) {
                }
            }
        }) ?: return
        pub = pubConn

        val subConn = WebRtc.factory.createPeerConnection(config(), object : SimplePcObserver() {
            override fun onIceCandidate(candidate: IceCandidate) {
                try {
                    send("sfu:sub-ice", candidateToMap(candidate))
                } catch (_: Exception) {
                }
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
                try {
                    reportState()
                    if (newState == PeerConnection.PeerConnectionState.FAILED) scope.launch { rejoin() }
                } catch (_: Exception) {
                }
            }
            // Fires when the SFU stops forwarding a track (screen share ended,
            // camera turned off); without it the last frame stayed frozen.
            override fun onRemoveTrack(receiver: org.webrtc.RtpReceiver) {
                try {
                    val gone = receiver.track() ?: return
                    for (set in remoteTracks.values) {
                        if (set.mic === gone) set.mic = null
                        if (set.cam === gone) set.cam = null
                        if (set.screen === gone) set.screen = null
                    }
                    onTracksChanged(remoteTracks.toMap())
                } catch (_: Exception) {
                }
            }
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out org.webrtc.MediaStream>) {
                try {
                    val streamId = streams.firstOrNull()?.id ?: return
                    val uid = streamId.toLongOrNull() ?: return
                    val trackId = receiver.track()?.id() ?: return
                    val set = remoteTracks.getOrPut(uid) { RemoteTrackSet() }
                    when (trackId) {
                        "mic" -> set.mic = receiver.track() as? org.webrtc.AudioTrack
                        "cam" -> set.cam = receiver.track() as? VideoTrack
                        "screen" -> set.screen = receiver.track() as? VideoTrack
                    }
                    onTracksChanged(remoteTracks.toMap())
                } catch (_: Exception) {
                }
            }
        }) ?: return
        sub = subConn

        media.audioTrack?.let { pubConn.addTrack(it, listOf(roomId)) }
        media.videoTrack?.let { camSender = pubConn.addTrack(it, listOf(roomId)) }
        screenCapture?.let { screenSender = pubConn.addTrack(it.track, listOf(roomId)) }
    }

    /**
     * Re-attach after the signaling socket reconnects. The server keeps our
     * participant (and its PeerConnections) for 15 s; if it answers
     * resumed=false (grace expired, or its side failed) we rebuild instead.
     */
    fun resume() {
        if (closed || roomId.isEmpty()) return
        resumePending = true
        send("room:join", mapOf("room_id" to roomId, "video" to (media.videoTrack?.enabled() ?: false), "resume" to true))
        pushTrackState()
    }

    fun handleRoomJoined(resumed: Boolean) {
        if (!resumePending) return
        resumePending = false
        if (!resumed) scope.launch { rejoin() }
    }

    /** Fresh PeerConnections + a fresh join, keeping the current camera/mic/screen capture. */
    private suspend fun rejoin() {
        if (closed || rejoining || roomId.isEmpty()) return
        rejoining = true
        try {
            makingOffer = false
            pub?.dispose(); sub?.dispose() // close() alone leaks the native connection
            pub = null; sub = null
            camSender = null; screenSender = null
            pendingPubCandidates.clear(); pendingSubCandidates.clear()
            pubHasRemote = false; subHasRemote = false
            remoteTracks.clear()
            onTracksChanged(emptyMap())
            buildPeers()
            send("room:join", mapOf("room_id" to roomId, "video" to (media.videoTrack?.enabled() ?: false), "resume" to false))
            if (sharing) pushTrackState(screen = true)
            publishOffer()
        } finally {
            rejoining = false
        }
    }

    /**
     * Re-sends "room:join" after a host admits a pending private-room
     * request. The first join() already built the PCs, acquired media, and
     * sent an offer — but the server dropped that offer since the
     * participant didn't exist yet (still pending). Reuses the existing
     * PCs/media instead of tearing them down.
     */
    fun resendJoin() {
        val conn = pub ?: return
        send("room:join", mapOf("room_id" to roomId, "video" to (media.videoTrack?.enabled() ?: false), "resume" to false))
        scope.launch { publishOffer() }
    }

    private fun reportState() {
        val ok = pub?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED &&
            sub?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED
        onConnectionState(ok)
    }

    private suspend fun publishOffer() {
        val conn = pub ?: return
        if (makingOffer || conn.signalingState() != PeerConnection.SignalingState.STABLE) return
        makingOffer = true
        try {
            val offer = conn.createOfferSuspend(MediaConstraints())
            conn.setLocalDescriptionSuspend(offer)
            send("sfu:pub-offer", mapOf("type" to "offer", "sdp" to offer.description))
        } catch (_: Exception) {
        } finally {
            makingOffer = false
        }
    }

    suspend fun handlePubAnswer(sdpObj: JsonObject) {
        val conn = pub ?: return
        try {
            conn.setRemoteDescriptionSuspend(SessionDescription(SessionDescription.Type.ANSWER, sdpText(sdpObj)))
            pubHasRemote = true
            pendingPubCandidates.forEach { conn.addIceCandidate(it) }
            pendingPubCandidates.clear()
        } catch (_: Exception) {
        }
    }

    fun handlePubIce(candidateObj: JsonObject) {
        val conn = pub ?: return
        val c = candidateFromJson(candidateObj)
        if (pubHasRemote || conn.remoteDescription != null) conn.addIceCandidate(c) else pendingPubCandidates.add(c)
    }

    suspend fun handleSubOffer(sdpObj: JsonObject) {
        val conn = sub ?: return
        try {
            conn.setRemoteDescriptionSuspend(SessionDescription(SessionDescription.Type.OFFER, sdpText(sdpObj)))
            subHasRemote = true
            pendingSubCandidates.forEach { conn.addIceCandidate(it) }
            pendingSubCandidates.clear()
            val answer = conn.createAnswerSuspend(MediaConstraints())
            conn.setLocalDescriptionSuspend(answer)
            send("sfu:sub-answer", mapOf("type" to "answer", "sdp" to answer.description))
        } catch (_: Exception) {
        }
    }

    fun handleSubIce(candidateObj: JsonObject) {
        val conn = sub ?: return
        val c = candidateFromJson(candidateObj)
        if (subHasRemote || conn.remoteDescription != null) conn.addIceCandidate(c) else pendingSubCandidates.add(c)
    }

    private fun sdpText(obj: JsonObject): String = (obj["sdp"] as JsonPrimitive).content

    fun setMic(on: Boolean) {
        media.setMic(on)
        pushTrackState()
    }

    /** Enables/disables the existing camera track, or acquires + publishes one the first time. */
    suspend fun setCam(on: Boolean) {
        val conn = pub
        if (on && media.videoTrack == null && conn != null) {
            media.startVideo()
            val track = media.videoTrack ?: return
            try {
                camSender = conn.addTrack(track, listOf(roomId))
            } catch (_: Exception) {
                return
            }
            pushTrackState(videoOn = true)
            return
        }
        media.setCam(on)
        pushTrackState()
    }

    private fun pushTrackState(screen: Boolean? = null, videoOn: Boolean? = null, muted: Boolean? = null) {
        send("sfu:track-state", mapOf(
            "muted" to (muted ?: !(media.audioTrack?.enabled() ?: false)),
            "video_on" to (videoOn ?: (media.videoTrack?.enabled() ?: false)),
            "screen" to (screen ?: sharing),
        ))
    }

    suspend fun startScreenShare(resultCode: Int, permissionIntent: Intent, onEnded: () -> Unit) {
        val conn = pub ?: return
        if (screenCapture != null) return
        // Announce BEFORE publishing so the server labels the next video track "screen".
        pushTrackState(screen = true)
        val capture = ScreenCapture(context, resultCode, permissionIntent)
        capture.onEnded = { scope.launch { stopScreenShare() }; onEnded() }
        screenCapture = capture
        try {
            screenSender = conn.addTrack(capture.track, listOf(roomId))
        } catch (e: Exception) {
            capture.close()
            screenCapture = null
            pushTrackState(screen = false)
            throw e
        }
    }

    suspend fun stopScreenShare() {
        screenSender?.let { runCatching { pub?.removeTrack(it) } }
        screenSender = null
        screenCapture?.close()
        screenCapture = null
        pushTrackState(screen = false)
    }

    fun leave(notifyServer: Boolean = true) {
        closed = true
        netMonitor.stop()
        if (notifyServer && roomId.isNotEmpty()) send("room:leave", emptyMap())
        // Connections first, then the local tracks they send; dispose() (not
        // close()) frees the native connection.
        pub?.dispose()
        sub?.dispose()
        pub = null
        sub = null
        media.close()
        screenCapture?.close()
        screenCapture = null
        remoteTracks.clear()
        roomId = ""
    }
}
