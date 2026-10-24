package com.videocall.mobile.call

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import com.videocall.mobile.net.Group
import com.videocall.mobile.net.ParticipantInfo
import com.videocall.mobile.net.UserBrief
import com.videocall.mobile.net.bool
import com.videocall.mobile.net.long
import com.videocall.mobile.net.obj
import com.videocall.mobile.net.str
import com.videocall.mobile.session.SessionManager

enum class CallStatus { IDLE, INCOMING, OUTGOING, CONNECTING, WAITING_APPROVAL, ACTIVE }
enum class CallMode { P2P, SFU }

data class Incoming(val callId: String, val from: UserBrief, val video: Boolean)
data class RoomInvite(val roomId: String, val groupName: String, val from: UserBrief)
data class JoinRequest(val roomId: String, val from: UserBrief)
data class Roster(val invitees: List<UserBrief>, val joined: List<Long>)

data class CallUiState(
    val status: CallStatus = CallStatus.IDLE,
    val mode: CallMode = CallMode.P2P,
    val callId: String? = null,
    val roomId: String? = null,
    val peer: UserBrief? = null,
    val group: Group? = null,
    val micOn: Boolean = true,
    val camOn: Boolean = false,
    val sharing: Boolean = false,
    val connected: Boolean = false,
    val participants: List<ParticipantInfo> = emptyList(),
    val incoming: Incoming? = null,
    val roomInvite: RoomInvite? = null,
    val privateRoomId: String? = null,
    val joinRequests: List<JoinRequest> = emptyList(), // host-side: people waiting to be let in
    val raisedHands: Set<Long> = emptySet(),
    val presenterOnly: Boolean = false,
    val roster: Roster? = null,
    val toast: String? = null,
    val tracksVersion: Int = 0, // bumped whenever remote tracks change, so Compose recomposes
    val remoteVideoTrack: org.webrtc.VideoTrack? = null, // p2p only
    val networkQuality: NetQuality = NetQuality.GOOD,
    val remoteMuted: Boolean = false, // p2p: the other side's mic state (web sends mute-state relays)
    val ringing: Boolean = false, // caller side: the callee's device is ringing
    val startedAt: Long? = null, // elapsedRealtime when media connected, for the call timer
    val speakerOn: Boolean = false,
    val wsReconnecting: Boolean = false,
) {
    // status alone doesn't capture a pending group-call invite (it stays
    // IDLE until accepted), so CallService/CallActivity check this instead
    // of `status != IDLE` when deciding whether a call is "live".
    val isLive: Boolean get() = status != CallStatus.IDLE || incoming != null || roomInvite != null
}

/**
 * Mirrors the relevant slice of web/src/store/calls.ts: the call state
 * machine plus the WS handler registrations that drive it. Kept private
 * DirectCall/RoomClient references — UI reads video tracks straight off
 * `direct`/`room` (see CallActivity) since raw WebRTC tracks don't belong
 * in a StateFlow.
 */
object CallRepository {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow(CallUiState())
    val state: StateFlow<CallUiState> = _state

    var direct: DirectCall? = null
        private set
    var room: RoomClient? = null
        private set

    private lateinit var appContext: Context

    // Re-attaches handlers to the current SessionManager.ws; called on every
    // SessionManager.bind() (including server switches), since each bind()
    // creates a brand-new WsClient that needs its own listeners.
    private var ringWatcher: kotlinx.coroutines.Job? = null

    fun registerOnce(context: Context) {
        appContext = context.applicationContext
        val ws = SessionManager.ws
        watchRinging()

        // The server keeps a 1:1 call alive briefly after the socket drops;
        // claim it back on reconnect or it ends the call.
        ws.on("ws:open") { _ ->
            val s = _state.value
            if (s.status == CallStatus.IDLE) return@on
            _state.value = s.copy(wsReconnecting = false)
            if (s.mode == CallMode.P2P && s.callId != null) {
                ws.send("call:resume", mapOf("call_id" to s.callId))
            } else if (s.mode == CallMode.SFU && s.status == CallStatus.ACTIVE) {
                // Re-attach to the room inside the server's 15 s grace period.
                room?.resume()
            }
        }
        ws.on("ws:close") { _ ->
            if (_state.value.status == CallStatus.ACTIVE) _state.value = _state.value.copy(wsReconnecting = true)
        }
        ws.on("call:invite") { data ->
            if (_state.value.status != CallStatus.IDLE) {
                ws.send("call:decline", mapOf("call_id" to data.str("call_id")))
                return@on
            }
            val from = parseUserBrief(data.obj()["from"]?.obj() ?: JsonObject(emptyMap()))
            val inc = Incoming(data.str("call_id") ?: return@on, from, data.bool("video") ?: false)
            _state.value = _state.value.copy(status = CallStatus.INCOMING, incoming = inc)
            showRinging()
            stopRingingAfterTimeout(inc)
            // Tell the caller this device is actually ringing now, not just that
            // the invite was delivered — mirrors web/src/store/calls.ts. Without
            // this, the caller only ever finds out via a final call:ended
            // (declined/no-answer/offline), with nothing in between.
            ws.send("call:ringing", mapOf("call_id" to inc.callId))
        }
        ws.on("call:ringing") { d ->
            if (!isCurrentCall(d.str("call_id"))) return@on
            if (_state.value.status == CallStatus.OUTGOING) _state.value = _state.value.copy(ringing = true)
        }
        ws.on("call:accepted") { d ->
            if (!isCurrentCall(d.str("call_id"))) return@on
            _state.value = _state.value.copy(status = CallStatus.CONNECTING, ringing = false, toast = null)
            val dc = direct ?: return@on
            dc.enableRenegotiation()
            scope.launch { dc.makeOffer() }
        }
        // Every call event names its call: an auto-declined second invite (we
        // were busy) makes the server send call:ended for THAT call id, which
        // used to tear down the call we were actually on.
        ws.on("call:declined") { d ->
            if (!isCurrentCall(d.str("call_id"))) return@on
            endCallLocal("Call declined")
        }
        ws.on("call:ended") { d ->
            val id = d.str("call_id")
            val s = _state.value
            if (id != null && id != s.callId && id != s.incoming?.callId) return@on
            val missed = s.incoming
            endCallLocal(callEndReasonToast(d.str("reason")))
            if (missed != null && !com.videocall.mobile.App.isInForeground) {
                IncomingCallNotifier.showMissed(appContext, missed.from, missed.video)
            }
        }
        ws.on("webrtc:relay") { d ->
            if (!isCurrentCall(d.str("call_id"))) return@on
            val payload = d.obj()["data"]?.obj() ?: return@on
            if ((payload["type"] as? JsonPrimitive)?.content == "mute-state") {
                _state.value = _state.value.copy(remoteMuted = payload.bool("muted") ?: false)
                return@on
            }
            scope.launch { direct?.onRelay(payload) }
        }
        // The server reports failed joins (not a member, room full, wrong
        // passcode...) as an "error" with code room-join; without handling it
        // the call screen spun on "Connecting" forever.
        ws.on("error") { d ->
            val s = _state.value
            val code = d.str("code")
            if (code == "room-join" && s.mode == CallMode.SFU && s.status != CallStatus.IDLE) {
                failCall(d.str("message") ?: "Couldn't join the call")
            } else if (code == "call" && s.mode == CallMode.P2P && (s.status == CallStatus.OUTGOING || s.status == CallStatus.CONNECTING)) {
                failCall(d.str("message") ?: "Call could not be started")
            }
        }
        ws.on("room:invite") { d ->
            if (_state.value.status != CallStatus.IDLE) return@on
            val from = parseUserBrief(d.obj()["from"]?.obj() ?: JsonObject(emptyMap()))
            val inv = RoomInvite(d.str("room_id") ?: return@on, d.str("group_name") ?: "", from)
            _state.value = _state.value.copy(roomInvite = inv)
            showRinging()
            scope.launch {
                kotlinx.coroutines.delay(45_000)
                if (_state.value.roomInvite?.roomId == inv.roomId) _state.value = _state.value.copy(roomInvite = null)
            }
        }
        ws.on("room:joined") { d ->
            val s = _state.value
            if (s.mode != CallMode.SFU || s.status == CallStatus.IDLE) return@on
            if (d.str("room_id") != null && d.str("room_id") != s.roomId) return@on
            val parts = (d.obj()["participants"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull {
                runCatching { com.videocall.mobile.net.json.decodeFromJsonElement<ParticipantInfo>(it) }.getOrNull()
            } ?: emptyList()
            room?.handleRoomJoined(d.bool("resumed") == true)
            _state.value = s.copy(status = CallStatus.ACTIVE, participants = parts, toast = null, wsReconnecting = false, startedAt = s.startedAt ?: android.os.SystemClock.elapsedRealtime())
            CallAudio.start(appContext, speaker = true)
        }
        ws.on("room:participant") { d ->
            val p = runCatching { com.videocall.mobile.net.json.decodeFromJsonElement<ParticipantInfo>(d.obj()["participant"] ?: return@on) }.getOrNull() ?: return@on
            val list = _state.value.participants.toMutableList()
            val idx = list.indexOfFirst { it.user_id == p.user_id }
            if (idx >= 0) list[idx] = p else list.add(p)
            _state.value = _state.value.copy(participants = list)
        }
        ws.on("room:left") { d ->
            val uid = d.long("user_id") ?: return@on
            _state.value = _state.value.copy(participants = _state.value.participants.filter { it.user_id != uid })
            room?.remoteTracks?.remove(uid)
        }
        // The server tells every group member when a group call is over, so a
        // call that ended while still ringing here stops ringing.
        ws.on("room:ended") { d ->
            val invite = _state.value.roomInvite ?: return@on
            if (d.str("room_id") == invite.roomId) _state.value = _state.value.copy(roomInvite = null)
        }
        // Joined this call on another device: stop ringing here.
        ws.on("room:answered") { d ->
            if (d.str("room_id") == _state.value.roomInvite?.roomId) _state.value = _state.value.copy(roomInvite = null)
        }
        ws.on("room:closed") { d ->
            // A group call that ended while it was still ringing here.
            val invite = _state.value.roomInvite
            if (invite != null && d.str("room_id") == invite.roomId) {
                _state.value = _state.value.copy(roomInvite = null)
                return@on
            }
            if (d.str("room_id") != null && d.str("room_id") != _state.value.roomId) return@on
            endCallLocal("This group call ended")
        }
        ws.on("room:removed") { d -> endCallLocal("You were removed from the call by the host") }
        ws.on("sfu:sub-offer") { d -> scope.launch { room?.handleSubOffer(d.obj()) } }
        ws.on("sfu:sub-ice") { d -> room?.handleSubIce(d.obj()) }
        ws.on("sfu:pub-answer") { d -> scope.launch { room?.handlePubAnswer(d.obj()) } }
        ws.on("sfu:pub-ice") { d -> room?.handlePubIce(d.obj()) }

        // ---- private rooms: join approval gate ----
        ws.on("room:join-pending") { d ->
            if (d.str("room_id") != null && d.str("room_id") != _state.value.roomId) return@on
            if (_state.value.status == CallStatus.CONNECTING) _state.value = _state.value.copy(status = CallStatus.WAITING_APPROVAL)
        }
        ws.on("room:join-approved") { d ->
            if (d.str("room_id") != null && d.str("room_id") != _state.value.roomId) return@on
            if (_state.value.status != CallStatus.WAITING_APPROVAL) return@on
            _state.value = _state.value.copy(status = CallStatus.CONNECTING)
            room?.resendJoin()
        }
        ws.on("room:join-denied") { d ->
            if (d.str("room_id") != null && d.str("room_id") != _state.value.roomId) return@on
            endCallLocal("The host denied your request to join")
        }
        // host-side: someone wants into a private room this client owns.
        ws.on("room:join-request") { d ->
            val roomId = d.str("room_id") ?: return@on
            val from = parseUserBrief(d.obj()["from"]?.obj() ?: return@on)
            _state.value = _state.value.copy(joinRequests = _state.value.joinRequests.filter { !(it.roomId == roomId && it.from.id == from.id) } + JoinRequest(roomId, from))
        }
        ws.on("call:raise-hand") { d ->
            if (d.str("room_id") != null && d.str("room_id") != _state.value.roomId) return@on
            val uid = d.long("user_id") ?: return@on
            val raised = d.bool("raised") ?: false
            _state.value = _state.value.copy(raisedHands = if (raised) _state.value.raisedHands + uid else _state.value.raisedHands - uid)
        }
        ws.on("room:muted") { d ->
            scope.launch {
                if (_state.value.mode == CallMode.SFU) room?.setMic(false) else direct?.setMic(false)
                _state.value = _state.value.copy(micOn = false, toast = if (d.bool("locked") == true) "You were muted and locked by the host" else "You were muted by the host")
            }
        }
        ws.on("room:unlocked") { _state.value = _state.value.copy(toast = "The host unlocked your microphone — you can unmute now") }
        ws.on("room:presenter-only") { d -> _state.value = _state.value.copy(presenterOnly = d.bool("enabled") ?: false) }
        ws.on("room:roster") { d ->
            val invitees = (d.obj()["invitees"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { runCatching { parseUserBrief(it.obj()) }.getOrNull() } ?: emptyList()
            val joined = (d.obj()["joined"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content?.toLongOrNull() } ?: emptyList()
            _state.value = _state.value.copy(roster = Roster(invitees, joined))
        }
    }

    // call:ended reasons that need explaining — "declined" has its own toast
    // already (see the call:declined handler), and "missed"/"hangup" don't
    // need one (the callee/either side already knows). Mirrors
    // web/src/store/calls.ts's callEndReasonToast.
    private fun callEndReasonToast(reason: String?): String? = when (reason) {
        "offline" -> "They're offline right now"
        "busy" -> "They're on another call"
        "no-answer" -> "No answer"
        "unavailable" -> "That call is no longer available"
        "server-error" -> "Something went wrong starting the call"
        else -> null
    }

    private fun stopAudio() {
        if (::appContext.isInitialized) CallAudio.stop(appContext)
    }

    private fun isCurrentCall(callId: String?): Boolean = callId == null || callId == _state.value.callId

    private fun onP2PConnection(s: org.webrtc.PeerConnection.PeerConnectionState) {
        if (s == org.webrtc.PeerConnection.PeerConnectionState.CONNECTED) {
            val cur = _state.value
            _state.value = cur.copy(status = CallStatus.ACTIVE, connected = true, startedAt = cur.startedAt ?: android.os.SystemClock.elapsedRealtime())
        } else if (s == org.webrtc.PeerConnection.PeerConnectionState.DISCONNECTED || s == org.webrtc.PeerConnection.PeerConnectionState.FAILED) {
            _state.value = _state.value.copy(connected = false)
        }
    }

    private fun parseUserBrief(obj: JsonObject): UserBrief = UserBrief(
        id = obj.long("id") ?: 0,
        display_name = obj.str("display_name") ?: "Unknown",
        username = obj.str("username") ?: "",
        avatar_file_id = obj.long("avatar_file_id"),
    )

    /**
     * Rings for an incoming call or group-call invite. With the app open, the
     * call screen opens by itself. In the background, a full-screen
     * notification rings instead; no foreground service is started until the
     * call is answered (Android forbids that from the background, and it used
     * to crash the app).
     */
    private fun showRinging() {
        if (com.videocall.mobile.App.isInForeground) {
            val intent = android.content.Intent(appContext, CallActivity::class.java).apply {
                flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
            }
            runCatching { appContext.startActivity(intent) }
        } else {
            IncomingCallNotifier.show(appContext, _state.value)
        }
    }

    // The server gives up on an unanswered call after 45 s and tells us. If
    // that message never arrives (the connection dropped while ringing),
    // stop ringing on our own rather than ring forever.
    private fun stopRingingAfterTimeout(inc: Incoming) {
        scope.launch {
            kotlinx.coroutines.delay(55_000)
            val s = _state.value
            if (s.incoming?.callId == inc.callId) {
                _state.value = s.copy(status = CallStatus.IDLE, incoming = null)
                if (!com.videocall.mobile.App.isInForeground) IncomingCallNotifier.showMissed(appContext, inc.from, inc.video)
            }
        }
    }

    // Plays one ringtone while a call rings and clears the ringing
    // notification the moment it's answered, declined or cancelled.
    private fun watchRinging() {
        if (ringWatcher != null) return
        ringWatcher = scope.launch {
            _state.collect { s ->
                if (s.incoming != null || s.roomInvite != null) {
                    Ringer.start(appContext)
                } else {
                    Ringer.stop(appContext)
                    IncomingCallNotifier.cancel(appContext)
                }
            }
        }
    }

    private fun launchCallUi() {
        CallService.ensureRunning(appContext)
        val intent = android.content.Intent(appContext, CallActivity::class.java).apply {
            flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK
        }
        appContext.startActivity(intent)
    }

    fun startDmCall(context: Context, peer: UserBrief, video: Boolean) {
        if (_state.value.status != CallStatus.IDLE) return
        val callId = "p2p-${UUID.randomUUID()}"
        _state.value = CallUiState(status = CallStatus.OUTGOING, mode = CallMode.P2P, callId = callId, peer = peer, camOn = video)
        launchCallUi()
        scope.launch {
            try {
                val ice = runCatching { SessionManager.api.iceServers().iceServers }.getOrDefault(emptyList())
                val dc = DirectCall(
                    context = context, scope = scope, isCaller = true, peerId = peer.id, callId = callId,
                    relay = { payload -> SessionManager.ws.send("webrtc:relay", mapOf("to" to peer.id, "call_id" to callId, "data" to jsonify(payload))) },
                    onRemoteVideo = { track -> _state.value = _state.value.copy(remoteVideoTrack = track); bumpTracks() },
                    onConnectionState = { s -> onP2PConnection(s) },
                    onNetworkQuality = { q -> _state.value = _state.value.copy(networkQuality = q) },
                )
                direct = dc
                dc.start(video, ice)
                CallAudio.start(appContext, speaker = video)
                _state.value = _state.value.copy(micOn = true, camOn = dc.media.videoTrack != null, speakerOn = video)
                SessionManager.ws.send("call:invite", mapOf("callee_id" to peer.id, "call_id" to callId, "video" to video))
            } catch (e: Exception) {
                failCall("Couldn't start the call — check microphone/camera access")
            }
        }
    }

    fun acceptIncoming(context: Context, withVideo: Boolean? = null) {
        val inc = _state.value.incoming ?: return
        val enableVideo = withVideo ?: inc.video
        val callId = inc.callId
        CallService.ensureRunning(appContext)
        _state.value = _state.value.copy(status = CallStatus.CONNECTING, mode = CallMode.P2P, callId = callId, peer = inc.from, incoming = null, camOn = enableVideo)
        scope.launch {
            try {
                val ice = runCatching { SessionManager.api.iceServers().iceServers }.getOrDefault(emptyList())
                val dc = DirectCall(
                    context = context, scope = scope, isCaller = false, peerId = inc.from.id, callId = callId,
                    relay = { payload -> SessionManager.ws.send("webrtc:relay", mapOf("to" to inc.from.id, "call_id" to callId, "data" to jsonify(payload))) },
                    onRemoteVideo = { track -> _state.value = _state.value.copy(remoteVideoTrack = track); bumpTracks() },
                    onConnectionState = { s -> onP2PConnection(s) },
                    onNetworkQuality = { q -> _state.value = _state.value.copy(networkQuality = q) },
                )
                direct = dc
                dc.start(enableVideo, ice)
                dc.enableRenegotiation()
                CallAudio.start(appContext, speaker = enableVideo)
                _state.value = _state.value.copy(micOn = true, camOn = dc.media.videoTrack != null, speakerOn = enableVideo)
                SessionManager.ws.send("call:accept", mapOf("call_id" to callId))
            } catch (e: Exception) {
                SessionManager.ws.send("call:decline", mapOf("call_id" to callId))
                failCall("Couldn't answer the call — check microphone/camera access")
            }
        }
    }

    fun declineIncoming() {
        val inc = _state.value.incoming ?: return
        SessionManager.ws.send("call:decline", mapOf("call_id" to inc.callId))
        _state.value = _state.value.copy(status = CallStatus.IDLE, incoming = null)
    }

    fun startGroupCall(context: Context, group: Group, video: Boolean = true) {
        if (_state.value.status != CallStatus.IDLE) return
        val roomId = "group:${group.id}"
        _state.value = CallUiState(status = CallStatus.CONNECTING, mode = CallMode.SFU, roomId = roomId, group = group, camOn = video)
        launchCallUi()
        joinRoom(context, roomId, video)
    }

    fun acceptRoomInvite(context: Context, video: Boolean = true) {
        val inv = _state.value.roomInvite ?: return
        CallService.ensureRunning(appContext)
        val groupId = inv.roomId.removePrefix("group:").toLongOrNull()
        val group = com.videocall.mobile.chat.ChatRepository.groups.value.firstOrNull { it.id == groupId }
            ?: groupId?.let { Group(id = it, name = inv.groupName) }
        _state.value = CallUiState(status = CallStatus.CONNECTING, mode = CallMode.SFU, roomId = inv.roomId, group = group, camOn = video)
        joinRoom(context, inv.roomId, video)
    }

    fun declineRoomInvite() {
        _state.value = _state.value.copy(roomInvite = null)
    }

    fun joinPrivateRoom(context: Context, roomId: String, name: String, passcode: String?, video: Boolean = true) {
        if (_state.value.status != CallStatus.IDLE) return
        val fullId = "priv:$roomId"
        _state.value = CallUiState(status = CallStatus.CONNECTING, mode = CallMode.SFU, roomId = fullId, privateRoomId = roomId, camOn = video)
        launchCallUi()
        scope.launch {
            try {
                val ice = runCatching { SessionManager.api.iceServers().iceServers }.getOrDefault(emptyList())
                val rc = RoomClient(
                    context = context, scope = scope,
                    send = { type, data -> SessionManager.ws.send(type, data) },
                    onTracksChanged = { bumpTracks() },
                    onConnectionState = { ok -> _state.value = _state.value.copy(connected = ok) },
                    onNetworkQuality = { q -> _state.value = _state.value.copy(networkQuality = q) },
                )
                room = rc
                rc.join(fullId, video, ice, passcode)
                _state.value = _state.value.copy(micOn = true, camOn = rc.media.videoTrack != null)
            } catch (e: Exception) {
                failCall("Couldn't join the room — check microphone/camera access")
            }
        }
    }

    // ---- host moderation (private rooms & group calls the current user hosts) ----
    fun admitJoinRequest(roomId: String, userId: Long) {
        SessionManager.ws.send("room:admit", mapOf("room_id" to roomId, "user_id" to userId))
        _state.value = _state.value.copy(joinRequests = _state.value.joinRequests.filterNot { it.roomId == roomId && it.from.id == userId })
    }

    fun denyJoinRequest(roomId: String, userId: Long) {
        SessionManager.ws.send("room:deny", mapOf("room_id" to roomId, "user_id" to userId))
        _state.value = _state.value.copy(joinRequests = _state.value.joinRequests.filterNot { it.roomId == roomId && it.from.id == userId })
    }

    fun muteParticipant(userId: Long, lock: Boolean = false) {
        SessionManager.ws.send("room:mute-request", mapOf("target_user_id" to userId, "lock" to lock))
    }

    fun unlockParticipant(userId: Long) {
        SessionManager.ws.send("room:unlock-request", mapOf("target_user_id" to userId))
    }

    fun kickParticipant(userId: Long) {
        SessionManager.ws.send("room:kick-request", mapOf("target_user_id" to userId))
    }

    fun setPresenterOnly(enabled: Boolean) {
        val roomId = _state.value.roomId ?: return
        SessionManager.ws.send("room:presenter-only-request", mapOf("room_id" to roomId, "enabled" to enabled))
    }

    fun setPresenter(userId: Long, allowed: Boolean) {
        SessionManager.ws.send("room:presenter-request", mapOf("target_user_id" to userId, "allowed" to allowed))
    }

    fun fetchRoster() {
        val roomId = _state.value.roomId ?: return
        SessionManager.ws.send("room:roster-request", mapOf("room_id" to roomId))
    }

    fun nudgeInvitee(userId: Long) {
        val roomId = _state.value.roomId ?: return
        SessionManager.ws.send("room:nudge-request", mapOf("room_id" to roomId, "target_user_id" to userId))
    }

    fun toggleRaiseHand() {
        val s = _state.value
        val roomId = s.roomId ?: return
        val me = SessionManager.me.value?.id ?: return
        val raised = me !in s.raisedHands
        // The server only relays this to the others, so track our own hand locally.
        _state.value = s.copy(raisedHands = if (raised) s.raisedHands + me else s.raisedHands - me)
        SessionManager.ws.send("call:raise-hand", mapOf("room_id" to roomId, "raised" to raised))
    }

    fun toggleSpeaker() {
        val on = !_state.value.speakerOn
        CallAudio.setSpeaker(appContext, on)
        _state.value = _state.value.copy(speakerOn = on)
    }

    private fun joinRoom(context: Context, roomId: String, video: Boolean) {
        scope.launch {
            try {
                val ice = runCatching { SessionManager.api.iceServers().iceServers }.getOrDefault(emptyList())
                val rc = RoomClient(
                    context = context, scope = scope,
                    send = { type, data -> SessionManager.ws.send(type, data) },
                    onTracksChanged = { bumpTracks() },
                    onConnectionState = { ok -> _state.value = _state.value.copy(connected = ok) },
                    onNetworkQuality = { q -> _state.value = _state.value.copy(networkQuality = q) },
                )
                room = rc
                rc.join(roomId, video, ice)
                _state.value = _state.value.copy(micOn = true, camOn = rc.media.videoTrack != null)
            } catch (e: Exception) {
                failCall("Couldn't join the call — check microphone/camera access")
            }
        }
    }

    fun toggleMic() {
        val s = _state.value
        val on = !s.micOn
        if (s.mode == CallMode.SFU) room?.setMic(on) else direct?.setMic(on)
        // Tell the other side of a 1:1 call, same as the web client does.
        if (s.mode == CallMode.P2P && s.peer != null && s.callId != null) {
            SessionManager.ws.send("webrtc:relay", mapOf("to" to s.peer.id, "call_id" to s.callId, "data" to mapOf("type" to "mute-state", "muted" to !on)))
        }
        _state.value = s.copy(micOn = on)
    }

    fun toggleCam() {
        val on = !_state.value.camOn
        scope.launch {
            if (_state.value.mode == CallMode.SFU) room?.setCam(on) else direct?.setCam(on)
            _state.value = _state.value.copy(camOn = on)
        }
    }

    fun switchCamera() {
        if (_state.value.mode == CallMode.SFU) room?.media?.switchCamera() else direct?.switchCamera()
    }

    fun startScreenShare(resultCode: Int, permissionIntent: android.content.Intent) {
        scope.launch {
            try {
                CallService.addMediaProjectionType()
                val onEnded = { _state.value = _state.value.copy(sharing = false); CallService.removeMediaProjectionType() }
                if (_state.value.mode == CallMode.SFU) room?.startScreenShare(resultCode, permissionIntent, onEnded)
                else direct?.startScreenShare(resultCode, permissionIntent, onEnded)
                _state.value = _state.value.copy(sharing = true)
            } catch (_: Exception) {
                CallService.removeMediaProjectionType()
                _state.value = _state.value.copy(toast = "Could not start screen share")
            }
        }
    }

    fun stopScreenShare() {
        scope.launch {
            if (_state.value.mode == CallMode.SFU) room?.stopScreenShare() else direct?.stopScreenShare()
            _state.value = _state.value.copy(sharing = false)
            CallService.removeMediaProjectionType()
        }
    }

    fun hangup() {
        val s = _state.value
        if (s.mode == CallMode.SFU) {
            room?.leave()
        } else if (s.callId != null) {
            SessionManager.ws.send("call:hangup", mapOf("call_id" to s.callId))
            direct?.close()
        }
        direct = null
        room = null
        stopAudio()
        _state.value = CallUiState()
    }

    private fun endCallLocal(toast: String?) {
        direct?.close()
        room?.leave(false)
        direct = null
        room = null
        stopAudio()
        _state.value = CallUiState(toast = toast)
    }

    /** Call setup blew up (usually WebRTC capture failing without permission) — clean up instead of crashing the app. */
    private fun failCall(toast: String) {
        runCatching { direct?.close() }
        runCatching { room?.leave(false) }
        direct = null
        room = null
        stopAudio()
        _state.value = CallUiState(toast = toast)
    }

    private fun bumpTracks() {
        _state.value = _state.value.copy(tracksVersion = _state.value.tracksVersion + 1)
    }

    // Turns the small string/number map used for webrtc:relay payloads into
    // plain values WsClient.send already knows how to serialize.
    private fun jsonify(v: Any): Any? = v
}
