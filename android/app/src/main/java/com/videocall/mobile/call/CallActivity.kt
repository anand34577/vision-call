package com.videocall.mobile.call

import android.Manifest
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.util.Rational
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.VectorConverter
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import org.webrtc.VideoTrack
import com.videocall.mobile.chat.ChatRepository
import com.videocall.mobile.chat.Convo
import com.videocall.mobile.net.Message
import com.videocall.mobile.net.ParticipantInfo
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.theme.VcColor
import com.videocall.mobile.ui.theme.VisionCallTheme

class CallActivity : ComponentActivity() {
    // Notification-triggered answer/join (tapping the full-screen incoming-call
    // notification) can't wait for a Composable — WebRTC capture crashes if
    // started before RECORD_AUDIO/CAMERA are actually granted, so this defers
    // acceptIncoming/acceptRoomInvite until the permission result comes back.
    private var pendingAutoAnswer = false
    private var pendingAutoJoinRoom = false

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        val micOk = results[Manifest.permission.RECORD_AUDIO]
            ?: (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        if (micOk) {
            if (pendingAutoAnswer) CallRepository.acceptIncoming(this)
            if (pendingAutoJoinRoom) CallRepository.acceptRoomInvite(this)
        } else if (pendingAutoAnswer || pendingAutoJoinRoom) {
            android.widget.Toast.makeText(this, "Microphone permission is required to answer calls", android.widget.Toast.LENGTH_LONG).show()
            if (pendingAutoAnswer) CallRepository.declineIncoming()
        }
        pendingAutoAnswer = false
        pendingAutoJoinRoom = false
    }
    private val screenCaptureLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        if (result.resultCode == Activity.RESULT_OK && data != null) {
            CallRepository.startScreenShare(result.resultCode, data)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        handleAutoActions(intent)

        setContent {
            VisionCallTheme(forceDark = true) {
                CallScreen(
                    inPip = inPip.value,
                    onFinish = { finish() },
                    onRequestScreenShare = {
                        val mgr = getSystemService(MediaProjectionManager::class.java)
                        screenCaptureLauncher.launch(mgr.createScreenCaptureIntent())
                    },
                )
            }
        }

        // Back during a call shrinks it to picture-in-picture instead of
        // leaving the call screen behind.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!enterPipIfInCall()) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.CREATED) {
                CallRepository.state.collect { applyCallState(it) }
            }
        }
    }

    private val inPip = mutableStateOf(false)
    private var proximityLock: PowerManager.WakeLock? = null

    private fun inCall(s: CallUiState) =
        s.incoming == null && s.roomInvite == null &&
            (s.status == CallStatus.ACTIVE || s.status == CallStatus.CONNECTING || s.status == CallStatus.OUTGOING)

    // The screen stays on for the whole call. On a voice call held to the ear
    // (earpiece, no video) the proximity sensor turns it off instead, like a
    // phone call.
    private fun applyCallState(s: CallUiState) {
        val ringingOrLive = inCall(s) || s.incoming != null || s.roomInvite != null
        if (ringingOrLive) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val earpiece = s.status == CallStatus.ACTIVE && s.mode == CallMode.P2P && !s.speakerOn && !s.camOn && s.remoteVideoTrack == null
        setProximity(earpiece)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && hasPip()) {
            runCatching { setPictureInPictureParams(pipParams(auto = inCall(s))) }
        }
    }

    private fun setProximity(on: Boolean) {
        val pm = getSystemService(PowerManager::class.java) ?: return
        if (on) {
            if (proximityLock?.isHeld == true) return
            if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
            proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "visioncall:proximity").also {
                it.setReferenceCounted(false)
                it.acquire(4 * 60 * 60 * 1000L)
            }
        } else {
            proximityLock?.let { if (it.isHeld) it.release() }
            proximityLock = null
        }
    }

    private fun hasPip() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipParams(auto: Boolean): PictureInPictureParams {
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(9, 16))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setAutoEnterEnabled(auto)
            b.setSeamlessResizeEnabled(true)
        }
        return b.build()
    }

    private fun enterPipIfInCall(): Boolean {
        if (!hasPip() || !inCall(CallRepository.state.value)) return false
        return runCatching { enterPictureInPictureMode(pipParams(auto = true)) }.getOrDefault(false)
    }

    // Android 12+ enters picture-in-picture by itself (setAutoEnterEnabled);
    // older versions need this.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) enterPipIfInCall()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip.value = isInPictureInPictureMode
    }

    override fun onDestroy() {
        setProximity(false)
        super.onDestroy()
    }

    // The call screen is single-instance: tapping Answer on the ringing
    // notification while it's already open arrives here, not in onCreate.
    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAutoActions(intent)
    }

    private fun handleAutoActions(intent: android.content.Intent?) {
        pendingAutoAnswer = intent?.getBooleanExtra(EXTRA_AUTO_ANSWER, false) == true
        pendingAutoJoinRoom = intent?.getBooleanExtra(EXTRA_AUTO_JOIN_ROOM, false) == true

        val needed = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
            .filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        } else {
            if (pendingAutoAnswer) CallRepository.acceptIncoming(this)
            if (pendingAutoJoinRoom) CallRepository.acceptRoomInvite(this)
            pendingAutoAnswer = false
            pendingAutoJoinRoom = false
        }
    }

    companion object {
        const val EXTRA_AUTO_ANSWER = "auto_answer"
        const val EXTRA_AUTO_JOIN_ROOM = "auto_join_room"
    }
}

private val Glass = Color.White.copy(alpha = 0.14f)

@Composable
fun CallScreen(inPip: Boolean = false, onFinish: () -> Unit, onRequestScreenShare: () -> Unit) {
    val state by CallRepository.state.collectAsState()
    var showParticipants by remember { mutableStateOf(false) }
    var showChat by remember { mutableStateOf(false) }
    val convo: Convo? = state.group?.let { Convo.GroupChat(it.id) } ?: state.peer?.let { Convo.Dm(it.id) }
    val toastContext = LocalContext.current
    val me by SessionManager.me.collectAsState()

    // Messages that arrive in this call's chat while the chat is closed: a
    // badge on the Chat button and a short banner you can tap to open it.
    val unreadMap by ChatRepository.unread.collectAsState()
    val chatUnread = convo?.let { unreadMap[it.key] } ?: 0
    val allMessages by ChatRepository.messages.collectAsState()
    val latest = convo?.let { allMessages[it.key]?.lastOrNull() }
    var banner by remember { mutableStateOf<Message?>(null) }
    LaunchedEffect(latest?.id) {
        val m = latest ?: return@LaunchedEffect
        val fresh = runCatching { java.time.Instant.parse(m.sent_at).isAfter(java.time.Instant.now().minusSeconds(30)) }.getOrDefault(false)
        if (!showChat && m.id > 0 && m.sender_id != me?.id && fresh) {
            banner = m
            delay(5000)
            if (banner?.id == m.id) banner = null
        }
    }

    LaunchedEffect(state.status, state.roomInvite) {
        if (state.status == CallStatus.IDLE && state.roomInvite == null) onFinish()
    }
    // A system Toast (not an in-app banner) survives the activity finishing right
    // after — call-ending events reset status to IDLE, which finishes this screen.
    LaunchedEffect(state.toast) {
        state.toast?.let { android.widget.Toast.makeText(toastContext, it, android.widget.Toast.LENGTH_LONG).show() }
    }

    if (inPip) {
        PipView(state)
        return
    }

    Box(Modifier.fillMaxSize().background(VcColor.CallBg)) {
        when {
            state.incoming != null -> IncomingCallView(state)
            state.roomInvite != null -> RoomInviteView(state)
            state.status == CallStatus.WAITING_APPROVAL -> WaitingApprovalView(state)
            state.mode == CallMode.SFU && state.status == CallStatus.ACTIVE -> ConferenceView(state)
            else -> DirectCallView(state)
        }
        if (state.incoming == null && state.roomInvite == null && state.status != CallStatus.WAITING_APPROVAL) {
            CallTopBar(state, Modifier.align(Alignment.TopCenter))
            CallControls(
                state,
                Modifier.align(Alignment.BottomCenter),
                onRequestScreenShare = onRequestScreenShare,
                onShowParticipants = { showParticipants = true },
                onShowChat = if (convo != null) { { showChat = true; banner = null } } else null,
                chatUnread = chatUnread,
            )
        }
        AnimatedVisibility(
            visible = state.sharing,
            modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 70.dp),
            enter = fadeIn() + slideInVertically { -it },
            exit = fadeOut() + slideOutVertically { -it },
        ) {
            Row(
                Modifier.clip(CircleShape).background(VcColor.Success.copy(alpha = 0.95f)).padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.ScreenShare, null, Modifier.size(16.dp), tint = Color.White)
                Text("  You're sharing your screen", color = Color.White, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.width(10.dp))
                FilledTonalButton(
                    onClick = { CallRepository.stopScreenShare() },
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 0.dp),
                    modifier = Modifier.height(30.dp),
                    colors = ButtonDefaults.filledTonalButtonColors(containerColor = Color.White.copy(alpha = 0.25f), contentColor = Color.White),
                ) { Text("Stop") }
            }
        }
        AnimatedVisibility(
            visible = banner != null && !showChat,
            modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = if (state.sharing) 116.dp else 70.dp, start = 16.dp, end = 16.dp),
            enter = fadeIn() + slideInVertically { -it },
            exit = fadeOut() + slideOutVertically { -it },
        ) {
            val m = banner
            Surface(
                onClick = { banner = null; showChat = true },
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                shadowElevation = 8.dp,
            ) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp).widthIn(max = 420.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.ChatBubble, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                    Column(Modifier.padding(start = 10.dp)) {
                        Text(m?.sender?.display_name ?: "New message", style = MaterialTheme.typography.labelLarge, maxLines = 1)
                        Text(
                            when {
                                m == null -> ""
                                m.is_encrypted -> m.decryptedContent ?: "Encrypted message"
                                m.file != null && m.content.isBlank() -> "Sent a file"
                                else -> m.content
                            },
                            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
        AnimatedVisibility(
            visible = state.joinRequests.isNotEmpty(),
            modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 64.dp),
            enter = fadeIn() + slideInVertically { -it },
            exit = fadeOut() + slideOutVertically { -it },
        ) { JoinRequestsBanner(state) }
    }

    if (showParticipants) ParticipantsSheet(state, onDismiss = { showParticipants = false })
    if (showChat && convo != null) CallChatSheet(convo, onDismiss = { showChat = false })
}

/** Name, call status/timer and connection health, over a top scrim. */
@Composable
private fun CallTopBar(state: CallUiState, modifier: Modifier = Modifier) {
    val title = when {
        state.group != null -> state.group.name
        state.privateRoomId != null -> "Room ${state.privateRoomId}"
        else -> state.peer?.display_name ?: ""
    }
    Column(
        modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.6f), Color.Transparent)))
            .statusBarsPadding().padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, color = Color.White, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            when {
                state.wsReconnecting || (state.status == CallStatus.ACTIVE && !state.connected) -> {
                    CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = VcColor.Away)
                    Text("  Reconnecting…", color = VcColor.Away, style = MaterialTheme.typography.labelLarge)
                }
                state.status == CallStatus.ACTIVE -> {
                    if (state.networkQuality != NetQuality.GOOD) {
                        Icon(Icons.Default.NetworkCheck, null, Modifier.size(14.dp), tint = if (state.networkQuality == NetQuality.POOR) VcColor.Danger else VcColor.Away)
                        Text(if (state.networkQuality == NetQuality.POOR) " Poor connection · " else " Weak connection · ", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelLarge)
                    }
                    CallTimer(state.startedAt)
                    if (state.sharing) Text(" · Sharing screen", color = VcColor.Online, style = MaterialTheme.typography.labelLarge)
                }
                state.status == CallStatus.OUTGOING -> Text(if (state.ringing) "Ringing…" else "Calling…", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelLarge)
                else -> Text("Connecting…", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun CallTimer(startedAt: Long?) {
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(startedAt) {
        while (true) { now = SystemClock.elapsedRealtime(); delay(1000) }
    }
    val secs = if (startedAt == null) 0 else ((now - startedAt) / 1000).coerceAtLeast(0)
    val text = if (secs >= 3600) "%d:%02d:%02d".format(secs / 3600, (secs % 3600) / 60, secs % 60) else "%02d:%02d".format(secs / 60, secs % 60)
    Text(text, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Medium))
}

@Composable
private fun PulsingAvatar(name: String, fileId: Long?, size: Int = 116) {
    val t = rememberInfiniteTransition(label = "rings")
    val accent = MaterialTheme.colorScheme.primary
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size((size * 2).dp)) {
        repeat(3) { i ->
            val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(2400, delayMillis = i * 800), RepeatMode.Restart), label = "ring$i")
            Box(
                Modifier.size(size.dp).scale(1f + p * 0.9f).clip(CircleShape)
                    .background(accent.copy(alpha = (1f - p) * 0.28f)),
            )
        }
        Avatar(name, fileId, size = size)
    }
}

@Composable
private fun CallBackdrop(content: @Composable BoxScope.() -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(listOf(accent.copy(alpha = 0.35f), Color(0xFF0B0F1A), VcColor.CallBg)),
        ),
        content = content,
    )
}

@Composable
private fun WaitingApprovalView(state: CallUiState) {
    CallBackdrop {
        Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Box(Modifier.size(96.dp).clip(CircleShape).background(Glass), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.HourglassTop, null, tint = Color.White, modifier = Modifier.size(44.dp))
            }
            Spacer(Modifier.height(24.dp))
            Text("Waiting to be let in", color = Color.White, style = MaterialTheme.typography.headlineSmall)
            Text(
                "The host of ${state.privateRoomId?.let { "room $it" } ?: "this room"} has been asked to admit you.",
                color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(top = 6.dp, start = 16.dp, end = 16.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Spacer(Modifier.height(36.dp))
            OutlinedButton(onClick = { CallRepository.hangup() }, colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)) { Text("Cancel") }
        }
    }
}

@Composable
private fun JoinRequestsBanner(state: CallUiState, modifier: Modifier = Modifier) {
    Surface(
        modifier.fillMaxWidth(0.94f),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.large,
        shadowElevation = 10.dp,
    ) {
        Column(Modifier.padding(12.dp).animateContentSize()) {
            state.joinRequests.forEach { req ->
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(req.from.display_name, req.from.avatar_file_id, size = 36)
                    Column(Modifier.weight(1f).padding(start = 10.dp)) {
                        Text(req.from.display_name, style = MaterialTheme.typography.titleSmall)
                        Text("wants to join", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { CallRepository.denyJoinRequest(req.roomId, req.from.id) }) { Text("Deny") }
                    Button(onClick = { CallRepository.admitJoinRequest(req.roomId, req.from.id) }, shape = MaterialTheme.shapes.medium) { Text("Admit") }
                }
            }
        }
    }
}

@Composable
private fun RingingScreen(name: String, fileId: Long?, subtitle: String, actions: @Composable RowScope.() -> Unit) {
    CallBackdrop {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(0.6f))
            PulsingAvatar(name, fileId)
            Text(name, color = Color.White, style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(6.dp))
            Text(subtitle, color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.weight(1f))
            Row(Modifier.fillMaxWidth().padding(bottom = 24.dp), horizontalArrangement = Arrangement.SpaceEvenly, content = actions)
        }
    }
}

@Composable
private fun RoomInviteView(state: CallUiState) {
    val inv = state.roomInvite ?: return
    val context = LocalContext.current
    val launchJoin = com.videocall.mobile.ui.util.rememberCallLauncher(
        onDenied = { android.widget.Toast.makeText(context, "Microphone permission is required to join calls", android.widget.Toast.LENGTH_LONG).show() },
        onStart = { video -> CallRepository.acceptRoomInvite(context, video) },
    )
    RingingScreen(inv.groupName, null, "${inv.from.display_name} started a group call") {
        RoundAction(Icons.Default.CallEnd, "Decline", VcColor.Danger) { CallRepository.declineRoomInvite() }
        RoundAction(Icons.Default.Mic, "Audio only", Glass) { launchJoin(false) }
        RoundAction(Icons.Default.Videocam, "Join", VcColor.Success) { launchJoin(true) }
    }
}

@Composable
private fun IncomingCallView(state: CallUiState) {
    val inc = state.incoming ?: return
    val context = LocalContext.current
    val launchAnswer = com.videocall.mobile.ui.util.rememberCallLauncher(
        onDenied = { android.widget.Toast.makeText(context, "Microphone permission is required to answer calls", android.widget.Toast.LENGTH_LONG).show() },
        onStart = { video -> CallRepository.acceptIncoming(context, video) },
    )
    RingingScreen(inc.from.display_name, inc.from.avatar_file_id, if (inc.video) "Incoming video call" else "Incoming voice call") {
        RoundAction(Icons.Default.CallEnd, "Decline", VcColor.Danger) { CallRepository.declineIncoming() }
        if (inc.video) RoundAction(Icons.Default.Mic, "Audio only", Glass) { launchAnswer(false) }
        RoundAction(if (inc.video) Icons.Default.Videocam else Icons.Default.Call, "Answer", VcColor.Success) { launchAnswer(inc.video) }
    }
}

@Composable
private fun RoundAction(icon: ImageVector, label: String, color: Color, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        FilledIconButton(
            onClick = onClick,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = color, contentColor = Color.White),
            modifier = Modifier.size(72.dp),
        ) { Icon(icon, label, modifier = Modifier.size(30.dp)) }
        Spacer(Modifier.height(10.dp))
        Text(label, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
private fun DirectCallView(state: CallUiState) {
    val direct = CallRepository.direct
    // Tapping the small preview swaps it with the big video.
    var swapped by remember { mutableStateOf(false) }
    val remote = state.remoteVideoTrack?.takeIf { state.status == CallStatus.ACTIVE }
    val local = direct?.media?.videoTrack?.takeIf { state.camOn }
    val big = if (swapped && local != null) local else remote
    val small = if (swapped && local != null) remote else local
    val front = direct?.media?.facingFront == true

    BoxWithConstraints(Modifier.fillMaxSize()) {
        if (big != null) {
            VideoSurface(big, mirror = big === local && front, modifier = Modifier.fillMaxSize())
        } else {
            CallBackdrop {
                Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (state.status == CallStatus.ACTIVE) Avatar(state.peer?.display_name ?: "?", state.peer?.avatar_file_id, size = 132)
                    else PulsingAvatar(state.peer?.display_name ?: "?", state.peer?.avatar_file_id)
                }
            }
        }
        if (state.remoteMuted && state.status == CallStatus.ACTIVE) {
            Row(
                Modifier.align(Alignment.Center).padding(top = 220.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Default.MicOff, null, Modifier.size(16.dp), tint = Color.White)
                Text(" ${state.peer?.display_name?.substringBefore(' ') ?: "They"} muted", color = Color.White, style = MaterialTheme.typography.labelLarge)
            }
        }
        if (small != null) {
            FloatingPreview(
                track = small,
                mirror = small === local && front,
                areaWidth = maxWidth,
                areaHeight = maxHeight,
                onTap = { swapped = !swapped },
            )
        }
    }
}

/**
 * The small video in the corner: drag it anywhere (it settles into the
 * nearest corner), tap to swap it with the big video, double-tap to make it
 * bigger or smaller.
 */
@Composable
private fun FloatingPreview(track: VideoTrack, mirror: Boolean, areaWidth: Dp, areaHeight: Dp, onTap: () -> Unit) {
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    var large by remember { mutableStateOf(false) }
    val w = if (large) 156.dp else 108.dp
    val h = if (large) 218.dp else 152.dp
    val margin = 16.dp
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + 76.dp
    val bottomInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + 124.dp
    var right by remember { mutableStateOf(true) }
    var top by remember { mutableStateOf(true) }

    fun target(): Offset = with(density) {
        Offset(
            x = if (right) (areaWidth - w - margin).toPx() else margin.toPx(),
            y = if (top) topInset.toPx() else (areaHeight - h - bottomInset).toPx(),
        )
    }
    val offset = remember { Animatable(Offset.Zero, Offset.VectorConverter) }
    LaunchedEffect(right, top, large, areaWidth, areaHeight) { offset.animateTo(target()) }

    Box(
        Modifier
            .offset { IntOffset(offset.value.x.roundToInt(), offset.value.y.roundToInt()) }
            .size(w, h)
            .shadow(12.dp, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .border(1.dp, Color.White.copy(alpha = 0.25f), RoundedCornerShape(18.dp))
            .background(VcColor.TileBg)
            .pointerInput(Unit) {
                detectDragGestures(
                    onDragEnd = {
                        val centerX = offset.value.x + with(density) { w.toPx() } / 2
                        val centerY = offset.value.y + with(density) { h.toPx() } / 2
                        val newRight = centerX > with(density) { areaWidth.toPx() } / 2
                        val newTop = centerY < with(density) { areaHeight.toPx() } / 2
                        if (newRight == right && newTop == top) scope.launch { offset.animateTo(target()) }
                        right = newRight
                        top = newTop
                    },
                ) { change, drag ->
                    change.consume()
                    scope.launch { offset.snapTo(offset.value + drag) }
                }
            }
            .pointerInput(Unit) { detectTapGestures(onTap = { onTap() }, onDoubleTap = { large = !large }) },
    ) {
        VideoSurface(track, mirror = mirror, modifier = Modifier.fillMaxSize())
    }
}

/** Picture-in-picture: just the other person's video (or their picture). */
@Composable
private fun PipView(state: CallUiState) {
    val me by SessionManager.me.collectAsState()
    val room = CallRepository.room
    @Suppress("UNUSED_VARIABLE") val tracksVersion = state.tracksVersion
    val track: VideoTrack? = if (state.mode == CallMode.SFU) {
        state.participants.filter { it.user_id != me?.id }
            .firstNotNullOfOrNull { p -> room?.remoteTracks?.get(p.user_id)?.let { it.screen ?: it.cam?.takeIf { p.video_on } } }
    } else {
        state.remoteVideoTrack
    }
    Box(Modifier.fillMaxSize().background(VcColor.CallBg), contentAlignment = Alignment.Center) {
        if (track != null) {
            VideoSurface(track, mirror = false, modifier = Modifier.fillMaxSize())
        } else {
            val name = state.peer?.display_name ?: state.group?.name ?: "Call"
            Avatar(name, state.peer?.avatar_file_id, size = 64)
        }
    }
}

@Composable
private fun ConferenceView(state: CallUiState) {
    val room = CallRepository.room
    val me by SessionManager.me.collectAsState()
    var pinnedId by remember { mutableStateOf<Long?>(null) }
    // Auto-spotlight whoever is sharing their screen.
    val sharer = state.participants.firstOrNull { it.screen && it.user_id != me?.id }?.user_id
    val spotlight = state.participants.firstOrNull { it.user_id == (pinnedId ?: sharer) }
    @Suppress("UNUSED_VARIABLE") val tracksVersion = state.tracksVersion // recompose on track changes

    Column(Modifier.fillMaxSize().statusBarsPadding().padding(top = 72.dp, bottom = 132.dp).padding(horizontal = 8.dp)) {
        if (spotlight != null) {
            Box(Modifier.weight(1f).fillMaxWidth().padding(4.dp)) {
                ParticipantTile(spotlight, state, room, me?.id, highlighted = true, onTap = { pinnedId = null })
            }
            LazyRow(Modifier.fillMaxWidth().height(120.dp).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(horizontal = 4.dp)) {
                items(state.participants.filter { it.user_id != spotlight.user_id }, key = { it.user_id }) { p ->
                    Box(Modifier.width(90.dp).fillMaxHeight()) { ParticipantTile(p, state, room, me?.id, compact = true, onTap = { pinnedId = p.user_id }) }
                }
            }
        } else {
            val n = state.participants.size
            val cols = if (n <= 2) 1 else 2
            val rowsOf = state.participants.chunked(cols)
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                rowsOf.forEach { row ->
                    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { p ->
                            Box(Modifier.weight(1f).fillMaxHeight()) { ParticipantTile(p, state, room, me?.id, onTap = { pinnedId = p.user_id }) }
                        }
                        if (row.size < cols) Spacer(Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun ParticipantTile(
    p: ParticipantInfo,
    state: CallUiState,
    room: RoomClient?,
    myId: Long?,
    onTap: () -> Unit,
    highlighted: Boolean = false,
    compact: Boolean = false,
) {
    val isMe = p.user_id == myId
    val tracks = room?.remoteTracks?.get(p.user_id)
    val video: VideoTrack? = when {
        isMe -> room?.media?.videoTrack?.takeIf { state.camOn }
        else -> tracks?.screen ?: tracks?.cam?.takeIf { p.video_on || p.screen }
    }
    Box(
        Modifier.fillMaxSize().clip(RoundedCornerShape(if (compact) 14.dp else 20.dp)).background(VcColor.TileBg)
            .then(if (highlighted) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(20.dp)) else Modifier)
            .clickable(onClick = onTap),
    ) {
        if (video != null) {
            VideoSurface(video, mirror = isMe && room?.media?.facingFront == true, fit = p.screen && !isMe, modifier = Modifier.fillMaxSize())
        } else {
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(VcColor.TileBgAlt, VcColor.TileBg))), contentAlignment = Alignment.Center) {
                Avatar(p.display_name, p.avatar_file_id, size = if (compact) 40 else 72)
            }
        }
        if (state.raisedHands.contains(p.user_id)) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(8.dp).size(28.dp).clip(CircleShape).background(VcColor.Away),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.PanTool, "Raised hand", tint = Color.White, modifier = Modifier.size(15.dp)) }
        }
        Row(
            Modifier.align(Alignment.BottomStart).padding(8.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f))
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (p.muted) Icon(Icons.Default.MicOff, "Muted", tint = VcColor.Danger, modifier = Modifier.size(13.dp).padding(end = 3.dp))
            if (p.host && !compact) Icon(Icons.Default.Star, "Host", tint = VcColor.Away, modifier = Modifier.size(13.dp).padding(end = 3.dp))
            Text(
                if (isMe) "You" else p.display_name,
                color = Color.White, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun CallControls(
    state: CallUiState,
    modifier: Modifier = Modifier,
    onRequestScreenShare: () -> Unit,
    onShowParticipants: () -> Unit,
    onShowChat: (() -> Unit)? = null,
    chatUnread: Int = 0,
) {
    val me by SessionManager.me.collectAsState()
    var more by remember { mutableStateOf(false) }
    Column(
        modifier.fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.7f))))
            .navigationBarsPadding().padding(top = 36.dp, bottom = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Every button is a perfect circle: size is derived from the width we actually have so
        // the Row never has to squeeze (which turned circles into ovals on narrow screens).
        BoxWithConstraints(Modifier.padding(horizontal = 12.dp)) {
            val count = if (onShowChat != null) 5 else 4 // round buttons incl. "More"
            val gap = 8.dp
            val pad = 10.dp
            // hang-up counts as 1.3 buttons wide; 1 gap between each of (count + 1) items
            val btn = ((maxWidth - pad * 2 - gap * count) / (count + 1.3f)).coerceIn(40.dp, 56.dp)
            Row(
                Modifier.clip(RoundedCornerShape(btn * 0.65f)).background(Color(0xFF1A1F2B).copy(alpha = 0.92f)).padding(horizontal = pad, vertical = pad),
                horizontalArrangement = Arrangement.spacedBy(gap),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ControlButton(if (state.micOn) Icons.Default.Mic else Icons.Default.MicOff, if (state.micOn) "Mute" else "Unmute", btn, off = !state.micOn) { CallRepository.toggleMic() }
                ControlButton(if (state.camOn) Icons.Default.Videocam else Icons.Default.VideocamOff, if (state.camOn) "Turn camera off" else "Turn camera on", btn, off = !state.camOn) { CallRepository.toggleCam() }
                ControlButton(if (state.speakerOn) Icons.Default.VolumeUp else Icons.Default.PhoneInTalk, if (state.speakerOn) "Speaker on" else "Earpiece", btn, active = state.speakerOn) { CallRepository.toggleSpeaker() }
                if (onShowChat != null) ControlButton(Icons.Default.ChatBubble, "Chat", btn, badge = chatUnread) { onShowChat() }
                Box {
                    ControlButton(Icons.Default.MoreHoriz, "More", btn) { more = true }
                    DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                        if (state.camOn) DropdownMenuItem(text = { Text("Switch camera") }, leadingIcon = { Icon(Icons.Default.Cameraswitch, null) }, onClick = { more = false; CallRepository.switchCamera() })
                        DropdownMenuItem(
                            text = { Text(if (state.sharing) "Stop sharing" else "Share screen") },
                            leadingIcon = { Icon(if (state.sharing) Icons.Default.StopScreenShare else Icons.Default.ScreenShare, null) },
                            onClick = { more = false; if (state.sharing) CallRepository.stopScreenShare() else onRequestScreenShare() },
                        )
                        if (state.mode == CallMode.SFU) {
                            val raised = me?.id?.let { state.raisedHands.contains(it) } ?: false
                            DropdownMenuItem(text = { Text(if (raised) "Lower hand" else "Raise hand") }, leadingIcon = { Icon(Icons.Default.PanTool, null) }, onClick = { more = false; CallRepository.toggleRaiseHand() })
                            DropdownMenuItem(text = { Text("Participants (${state.participants.size})") }, leadingIcon = { Icon(Icons.Default.People, null) }, onClick = { more = false; onShowParticipants() })
                        }
                    }
                }
                FilledIconButton(
                    onClick = { CallRepository.hangup() },
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = VcColor.Danger, contentColor = Color.White),
                    modifier = Modifier.size(width = btn * 1.3f, height = btn),
                    shape = RoundedCornerShape(btn / 2),
                ) { Icon(Icons.Default.CallEnd, "Hang up", Modifier.size(btn / 2)) }
            }
        }
    }
}

@Composable
private fun ControlButton(icon: ImageVector, label: String, size: Dp, off: Boolean = false, active: Boolean = false, badge: Int = 0, onClick: () -> Unit) {
    Box {
    FilledIconButton(
        onClick = onClick,
        modifier = Modifier.size(size),
        shape = CircleShape,
        colors = IconButtonDefaults.filledIconButtonColors(
            containerColor = when {
                off -> Color.White
                active -> MaterialTheme.colorScheme.primary
                else -> Glass
            },
            contentColor = if (off) Color(0xFF111827) else Color.White,
        ),
    ) { Icon(icon, label, Modifier.size(24.dp)) }
    if (badge > 0) {
        Box(
            Modifier.align(Alignment.TopEnd).offset(x = 2.dp, y = (-2).dp).sizeIn(minWidth = 20.dp, minHeight = 20.dp)
                .clip(CircleShape).background(VcColor.Danger).padding(horizontal = 5.dp),
            contentAlignment = Alignment.Center,
        ) { Text(if (badge > 9) "9+" else "$badge", color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold) }
    }
    }
}

@Composable
private fun ParticipantsSheet(state: CallUiState, onDismiss: () -> Unit) {
    val me by SessionManager.me.collectAsState()
    val amHost = state.participants.any { it.user_id == me?.id && it.host }
    LaunchedEffect(Unit) { if (amHost && state.privateRoomId != null) CallRepository.fetchRoster() }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Text("In this call · ${state.participants.size}", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
            if (amHost) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Presenter-only screen share", style = MaterialTheme.typography.bodyLarge)
                        Text("Only you and approved presenters can share", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = state.presenterOnly, onCheckedChange = { CallRepository.setPresenterOnly(it) })
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(state.participants, key = { it.user_id }) { p ->
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(p.display_name, p.avatar_file_id, size = 40)
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text(p.display_name + if (p.user_id == me?.id) " (you)" else "", style = MaterialTheme.typography.bodyLarge)
                            val tags = listOfNotNull(if (p.host) "Host" else null, if (p.screen) "Presenting" else null, if (p.locked) "Mic locked" else null)
                            if (tags.isNotEmpty()) Text(tags.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                        }
                        if (state.raisedHands.contains(p.user_id)) Icon(Icons.Default.PanTool, "Raised hand", tint = VcColor.Away, modifier = Modifier.size(18.dp).padding(end = 4.dp))
                        Icon(if (p.muted) Icons.Default.MicOff else Icons.Default.Mic, null, tint = if (p.muted) VcColor.Danger else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                        if (amHost && p.user_id != me?.id) {
                            var menu by remember { mutableStateOf(false) }
                            Box {
                                IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Actions") }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    DropdownMenuItem(text = { Text("Mute") }, leadingIcon = { Icon(Icons.Default.MicOff, null) }, onClick = { CallRepository.muteParticipant(p.user_id); menu = false })
                                    DropdownMenuItem(text = { Text("Mute & lock") }, leadingIcon = { Icon(Icons.Default.Lock, null) }, onClick = { CallRepository.muteParticipant(p.user_id, lock = true); menu = false })
                                    if (p.locked) DropdownMenuItem(text = { Text("Unlock mic") }, leadingIcon = { Icon(Icons.Default.LockOpen, null) }, onClick = { CallRepository.unlockParticipant(p.user_id); menu = false })
                                    DropdownMenuItem(text = { Text(if (p.can_present) "Revoke presenter" else "Allow presenting") }, leadingIcon = { Icon(Icons.Default.ScreenShare, null) }, onClick = { CallRepository.setPresenter(p.user_id, !p.can_present); menu = false })
                                    DropdownMenuItem(text = { Text("Remove from call", color = MaterialTheme.colorScheme.error) }, leadingIcon = { Icon(Icons.Default.PersonRemove, null, tint = MaterialTheme.colorScheme.error) }, onClick = { CallRepository.kickParticipant(p.user_id); menu = false })
                                }
                            }
                        }
                    }
                }
            }
            state.roster?.let { roster ->
                val notJoined = roster.invitees.filter { it.id !in roster.joined }
                if (notJoined.isNotEmpty()) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Text("Invited, not here yet", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
                    notJoined.forEach { u ->
                        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(u.display_name, u.avatar_file_id, size = 36)
                            Text(u.display_name, Modifier.weight(1f).padding(start = 12.dp))
                            FilledTonalButton(onClick = { CallRepository.nudgeInvitee(u.id) }) { Text("Ring") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CallChatSheet(convo: Convo, onDismiss: () -> Unit) {
    val me by SessionManager.me.collectAsState()
    val allMessages by ChatRepository.messages.collectAsState()
    val messages = allMessages[convo.key] ?: emptyList()
    var input by remember { mutableStateOf("") }
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()

    DisposableEffect(convo) {
        ChatRepository.setActive(convo)
        onDispose { ChatRepository.setActive(null) }
    }
    LaunchedEffect(convo) { ChatRepository.loadHistory(convo) }
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxWidth().heightIn(min = 320.dp, max = 560.dp).navigationBarsPadding().imePadding()) {
            Text("Chat", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp))
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                items(messages, key = { it.clientId ?: it.id }) { msg -> CallChatBubble(msg, isMine = msg.sender_id == me?.id) }
            }
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it; ChatRepository.sendTyping(convo) },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Message") },
                    singleLine = true,
                    shape = RoundedCornerShape(24.dp),
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(onClick = {
                    if (input.isBlank()) return@FilledIconButton
                    ChatRepository.sendMessage(convo, input)
                    input = ""
                }, modifier = Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Filled.Send, "Send") }
            }
        }
    }
}

@Composable
private fun CallChatBubble(msg: Message, isMine: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (isMine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier
                .clip(RoundedCornerShape(18.dp))
                .background(if (isMine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .widthIn(max = 260.dp),
        ) {
            if (!isMine) Text(msg.sender?.display_name ?: "Unknown", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            Text(
                when {
                    msg.deleted_at != null -> "Message deleted"
                    msg.is_encrypted -> msg.decryptedContent ?: "Encrypted message"
                    msg.file != null && msg.content.isBlank() -> "Attachment: ${msg.file.name}"
                    else -> msg.content
                },
                color = if (isMine) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/**
 * One WebRTC video, drawn into a TextureView so rounded corners, dragging
 * and animations apply to it (see TextureVideoRenderer). Keyed on the track
 * so a swapped track gets a fresh renderer; released on disposal, since each
 * renderer holds an EGL context.
 */
@Composable
private fun VideoSurface(track: VideoTrack, mirror: Boolean, modifier: Modifier = Modifier, fit: Boolean = false) {
    key(track) {
        AndroidView(
            modifier = modifier,
            factory = { ctx ->
                TextureVideoRenderer(ctx).apply {
                    init(WebRtc.eglBase.eglBaseContext, fill = !fit)
                    setMirror(mirror)
                    track.addSink(this)
                }
            },
            update = {
                it.setMirror(mirror)
                it.setFill(!fit)
            },
            onRelease = { renderer ->
                runCatching { track.removeSink(renderer) }
                renderer.release()
            },
        )
    }
}
