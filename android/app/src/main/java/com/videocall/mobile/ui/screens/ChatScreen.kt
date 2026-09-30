package com.videocall.mobile.ui.screens

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import java.io.File
import java.time.Instant
import com.videocall.mobile.call.CallRepository
import com.videocall.mobile.chat.ChatRepository
import com.videocall.mobile.chat.Convo
import com.videocall.mobile.chat.Crypto
import com.videocall.mobile.net.FileBrief
import com.videocall.mobile.net.Group
import com.videocall.mobile.net.Message
import com.videocall.mobile.net.User
import com.videocall.mobile.net.UserBrief
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.ConfirmDialog
import com.videocall.mobile.ui.components.clockTime
import com.videocall.mobile.ui.components.dayLabel
import com.videocall.mobile.ui.components.localDateOf
import com.videocall.mobile.ui.components.presenceLabel
import com.videocall.mobile.ui.theme.VcColor
import com.videocall.mobile.ui.util.humanFileSize
import com.videocall.mobile.ui.util.openAttachment
import com.videocall.mobile.ui.util.rememberCallLauncher
import com.videocall.mobile.ui.util.VoiceRecorder

private val QuickReactions = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

/** A row in the (bottom-anchored, reversed) message list. */
private sealed class ChatRow {
    data class Day(val label: String) : ChatRow()
    data class Msg(val msg: Message, val firstOfRun: Boolean, val lastOfRun: Boolean) : ChatRow()
}

/** Groups consecutive messages from one sender (within 5 min) and inserts day separators. */
private fun buildRows(messages: List<Message>): List<ChatRow> {
    val rows = mutableListOf<ChatRow>()
    fun time(m: Message) = runCatching { Instant.parse(m.sent_at).toEpochMilli() }.getOrDefault(0L)
    for ((i, m) in messages.withIndex()) {
        val prev = messages.getOrNull(i - 1)
        val next = messages.getOrNull(i + 1)
        if (prev == null || localDateOf(prev.sent_at) != localDateOf(m.sent_at)) rows += ChatRow.Day(dayLabel(m.sent_at))
        val sameAsPrev = prev != null && prev.sender_id == m.sender_id && localDateOf(prev.sent_at) == localDateOf(m.sent_at) && time(m) - time(prev) < 5 * 60_000
        val sameAsNext = next != null && next.sender_id == m.sender_id && localDateOf(next.sent_at) == localDateOf(m.sent_at) && time(next) - time(m) < 5 * 60_000
        rows += ChatRow.Msg(m, firstOfRun = !sameAsPrev, lastOfRun = !sameAsNext)
    }
    return rows
}

@Composable
fun ChatScreen(convo: Convo, onBack: () -> Unit, onOpenPinned: () -> Unit = {}, onOpenGroupInfo: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val me by SessionManager.me.collectAsState()
    val presence by SessionManager.presence.collectAsState()
    val allMessages by ChatRepository.messages.collectAsState()
    val encryptedMap by ChatRepository.encryptedConvos.collectAsState()
    val savedIds by ChatRepository.savedIds.collectAsState()
    val hasMoreMap by ChatRepository.hasMore.collectAsState()
    val loadingOlder by ChatRepository.loadingOlder.collectAsState()
    val sendError by ChatRepository.sendError.collectAsState()
    val typingMap by ChatRepository.typingIn(convo).collectAsState()
    val groups by ChatRepository.groups.collectAsState()
    val prefs by ChatRepository.prefs.collectAsState()
    val groupReads by ChatRepository.groupReads.collectAsState()
    val directory by SessionManager.users.collectAsState()
    val pref = prefs[convo.key]
    // Replies inside a thread live in the thread sheet, not the main timeline.
    val messages = (allMessages[convo.key] ?: emptyList()).filter { it.thread_root_id == null }
    val blockedSet by ChatRepository.blocked.collectAsState()
    val peerBlocked = convo is Convo.Dm && blockedSet.contains(convo.peerId)
    val encrypted = encryptedMap[convo.key] ?: false
    val typingName = typingMap[convo.key]
    var lightboxFile by remember { mutableStateOf<FileBrief?>(null) }
    var input by remember { mutableStateOf("") }
    var peer by remember { mutableStateOf<User?>(null) }
    val group: Group? = (convo as? Convo.GroupChat)?.let { c -> groups.firstOrNull { it.id == c.groupId } }
    val iAmModerator = group != null && (me?.role == "admin" || group.members.firstOrNull { it.id == me?.id }?.role.let { it == "owner" || it == "admin" })
    var replyTo by remember { mutableStateOf<Message?>(null) }
    var actionsFor by remember { mutableStateOf<Message?>(null) }
    var deleteTarget by remember { mutableStateOf<Message?>(null) }
    var editingMsg by remember { mutableStateOf<Message?>(null) }
    var forwardMsg by remember { mutableStateOf<Message?>(null) }
    var threadRoot by remember { mutableStateOf<Message?>(null) }
    var showPollDialog by remember { mutableStateOf(false) }
    var confirmBlock by remember { mutableStateOf(false) }
    var uploading by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val listState = rememberLazyListState()
    val rows = remember(messages) { buildRows(messages).asReversed() }
    val knownUsernames = remember(groups, peer) {
        (group?.members?.map { it.username } ?: emptyList()) + listOfNotNull(peer?.username, me?.username)
    }

    val launchCall = rememberCallLauncher(
        onDenied = { scope.launch { snackbar.showSnackbar("Microphone/camera permission is needed to call") } },
        onStart = { video ->
            when (convo) {
                is Convo.Dm -> peer?.let { CallRepository.startDmCall(context, UserBrief(it.id, it.display_name, it.username, it.avatar_file_id), video) }
                is Convo.GroupChat -> group?.let { CallRepository.startGroupCall(context, it, video) }
            }
        },
    )

    // Attachments: pick from the gallery, take a photo or choose documents,
    // then review them (with a caption) before anything is uploaded.
    var showAttachSheet by remember { mutableStateOf(false) }
    var staged by remember { mutableStateOf<List<StagedFile>>(emptyList()) }
    var sendProgress by remember { mutableStateOf<Float?>(null) }
    var cameraUri by remember { mutableStateOf<android.net.Uri?>(null) }
    val stage: (List<android.net.Uri>) -> Unit = { uris -> if (uris.isNotEmpty()) staged = staged + uris.map { stagedFileOf(context, it) } }

    val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { stage(it) }
    val pickDocs = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { stage(it) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri
        if (ok && uri != null) stage(listOf(uri))
    }
    val launchCamera: () -> Unit = {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val photo = File(dir, "photo_${System.currentTimeMillis()}.jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", photo)
        cameraUri = uri
        runCatching { takePhoto.launch(uri) }.onFailure { scope.launch { snackbar.showSnackbar("No camera app available") } }
    }
    // The app declares the camera permission, so Android requires it to be
    // granted even to hand the photo off to the camera app.
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else scope.launch { snackbar.showSnackbar("Camera permission is needed to take a photo") }
    }
    val openCamera: () -> Unit = {
        if (androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) launchCamera()
        else cameraPermission.launch(android.Manifest.permission.CAMERA)
    }

    // Voice messages: hold the recorder, count seconds, upload on send.
    val recorder = remember { VoiceRecorder(context) }
    var recording by remember { mutableStateOf(false) }
    var recSecs by remember { mutableIntStateOf(0) }
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }
    LaunchedEffect(recording) {
        recSecs = 0
        while (recording) { kotlinx.coroutines.delay(1000); recSecs++ }
    }
    val startRecording: () -> Unit = {
        if (recorder.start()) recording = true else scope.launch { snackbar.showSnackbar("Couldn't start recording") }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startRecording() else scope.launch { snackbar.showSnackbar("Microphone permission is needed to record") }
    }
    val onMic: () -> Unit = {
        if (androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) startRecording()
        else micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
    }
    val sendRecording: () -> Unit = {
        recording = false
        val file = recorder.stop()
        val reply = replyTo
        if (file != null) scope.launch {
            uploading = true
            runCatching { SessionManager.api.uploadFile(file, "audio/mp4") }
                .onSuccess { ChatRepository.sendMessage(convo, "", fileId = it.id, replyToId = reply?.id); replyTo = null }
                .onFailure { snackbar.showSnackbar(it.message ?: "Couldn't send voice message") }
            file.delete()
            uploading = false
        }
    }

    // Uploads one at a time (parallel uploads race the per-user storage
    // quota). The caption goes with the first file.
    val sendStaged: (String) -> Unit = { caption ->
        val files = staged
        val reply = replyTo
        scope.launch {
            uploading = true
            sendProgress = 0f
            var failed = 0
            var lastError: String? = null
            files.forEachIndexed { i, f ->
                runCatching { uploadStaged(context, f) { p -> sendProgress = (i + p) / files.size } }
                    .onSuccess { id ->
                        ChatRepository.sendMessage(convo, if (i == 0) caption else "", fileId = id, replyToId = if (i == 0) reply?.id else null)
                    }
                    .onFailure { failed++; lastError = it.message }
            }
            replyTo = null
            staged = emptyList()
            sendProgress = null
            uploading = false
            if (failed > 0) snackbar.showSnackbar(if (files.size == 1) lastError ?: "Upload failed" else "$failed of ${files.size} files failed to upload")
        }
    }

    // "Active" (auto-read, no notifications) only while this screen is actually
    // visible — backgrounding the app with a chat open must not mark new
    // messages read or swallow their notifications.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(convo, lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> ChatRepository.setActive(convo)
                Lifecycle.Event.ON_STOP -> ChatRepository.setActive(null)
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            ChatRepository.setActive(null)
        }
    }

    LaunchedEffect(convo) {
        ChatRepository.loadHistory(convo)
        ChatRepository.fetchSaved()
        when (convo) {
            is Convo.Dm -> peer = runCatching { SessionManager.api.users().firstOrNull { it.id == convo.peerId } }.getOrNull()
            is Convo.GroupChat -> ChatRepository.loadGroups()
        }
    }

    // New message at the bottom: follow it if we're already at the bottom, or if it's ours.
    val newestId = messages.lastOrNull()?.let { it.clientId ?: it.id.toString() }
    LaunchedEffect(newestId) {
        val newest = messages.lastOrNull() ?: return@LaunchedEffect
        if (listState.firstVisibleItemIndex <= 2 || newest.sender_id == me?.id) listState.animateScrollToItem(0)
    }
    // Reaching the oldest loaded message pages in the previous 50.
    val nearTop by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= rows.size - 3 } ?: false } }
    LaunchedEffect(nearTop, hasMoreMap[convo.key]) {
        if (nearTop && hasMoreMap[convo.key] == true) ChatRepository.loadOlder(convo)
    }
    LaunchedEffect(sendError) {
        sendError?.let { snackbar.showSnackbar(it); ChatRepository.clearSendError() }
    }

    val title = peer?.display_name ?: group?.name ?: ""
    val peerStatus = peer?.let { presence[it.id] ?: it.status }
    val subtitle = when {
        typingName != null -> if (convo is Convo.GroupChat) "$typingName ${if (typingName.contains(", ")) "are" else "is"} typing…" else "typing…"
        group != null -> "${group.members.size} members" + if (encrypted) " · encrypted" else ""
        peer != null -> presenceLabel(peerStatus) + (peer?.status_text?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "") + if (encrypted) " · encrypted" else ""
        else -> ""
    }

    if (showAttachSheet) {
        AttachSheet(
            onDismiss = { showAttachSheet = false },
            onGallery = { pickMedia.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            onCamera = openCamera,
            onDocument = { pickDocs.launch(arrayOf("*/*")) },
        )
    }
    if (staged.isNotEmpty()) {
        AttachmentPreviewDialog(
            files = staged,
            encrypted = encrypted,
            sending = uploading,
            progress = sendProgress,
            onRemove = { i -> staged = staged.filterIndexed { j, _ -> j != i } },
            onAddMore = { showAttachSheet = true },
            onCancel = { staged = emptyList() },
            onSend = sendStaged,
        )
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                Row(
                    Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 4.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                    Row(
                        Modifier.weight(1f).clip(MaterialTheme.shapes.medium)
                            .clickable(enabled = convo is Convo.GroupChat) { onOpenGroupInfo() }.padding(4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(title, peer?.avatar_file_id ?: group?.avatar_file_id, size = 40, status = peerStatus)
                        Column(Modifier.padding(start = 10.dp)) {
                            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (subtitle.isNotEmpty()) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (encrypted && typingName == null) Icon(Icons.Default.Lock, null, Modifier.size(12.dp).padding(end = 3.dp), tint = VcColor.Online)
                                    Text(
                                        subtitle, style = MaterialTheme.typography.labelMedium, maxLines = 1,
                                        color = if (typingName != null || peerStatus == "online") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                    IconButton(onClick = { launchCall(false) }) { Icon(Icons.Default.Call, "Voice call") }
                    IconButton(onClick = { launchCall(true) }) { Icon(Icons.Default.Videocam, "Video call") }
                    Box {
                        IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, "More") }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(if (encrypted) "Turn off encryption" else "Encrypt messages") },
                                leadingIcon = { Icon(if (encrypted) Icons.Default.LockOpen else Icons.Default.Lock, null) },
                                onClick = {
                                    menuOpen = false
                                    if (encrypted) {
                                        ChatRepository.setEncrypted(convo, false)
                                    } else scope.launch {
                                        // Only offer encryption when every recipient can actually read it (same gate as web).
                                        val others = when (convo) {
                                            is Convo.Dm -> listOf(convo.peerId)
                                            is Convo.GroupChat -> group?.members?.map { it.id }?.filter { it != me?.id } ?: emptyList()
                                        }
                                        val missing = Crypto.usersMissingKeys(others)
                                        if (missing.isEmpty()) {
                                            ChatRepository.setEncrypted(convo, true)
                                            snackbar.showSnackbar("New messages will be end-to-end encrypted")
                                        } else {
                                            snackbar.showSnackbar(
                                                if (convo is Convo.Dm) "$title hasn't signed in on an encryption-capable device yet"
                                                else "${missing.size} member(s) haven't set up encryption yet",
                                            )
                                        }
                                    }
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(if (pref?.muted == true) "Unmute notifications" else "Mute notifications") },
                                leadingIcon = { Icon(if (pref?.muted == true) Icons.Default.Notifications else Icons.Default.NotificationsOff, null) },
                                onClick = { menuOpen = false; ChatRepository.setPref(convo, muted = pref?.muted != true) },
                            )
                            DropdownMenuItem(
                                text = { Text(if (pref?.archived == true) "Move back to chats" else "Archive chat") },
                                leadingIcon = { Icon(if (pref?.archived == true) Icons.Default.Unarchive else Icons.Default.Archive, null) },
                                onClick = {
                                    menuOpen = false
                                    val archiving = pref?.archived != true
                                    ChatRepository.setPref(convo, archived = archiving)
                                    if (archiving) onBack()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Create poll") },
                                leadingIcon = { Icon(Icons.Default.Poll, null) },
                                onClick = { menuOpen = false; showPollDialog = true },
                            )
                            if (convo is Convo.Dm) DropdownMenuItem(
                                text = { Text(if (peerBlocked) "Unblock" else "Block") },
                                leadingIcon = { Icon(Icons.Default.Block, null) },
                                onClick = {
                                    menuOpen = false
                                    if (peerBlocked) scope.launch { runCatching { ChatRepository.setBlocked(convo.peerId, false) } } else confirmBlock = true
                                },
                            )
                            DropdownMenuItem(text = { Text("Pinned messages") }, leadingIcon = { Icon(Icons.Outlined.PushPin, null) }, onClick = { menuOpen = false; onOpenPinned() })
                            if (convo is Convo.GroupChat) {
                                DropdownMenuItem(text = { Text("Group info") }, leadingIcon = { Icon(Icons.Default.Info, null) }, onClick = { menuOpen = false; onOpenGroupInfo() })
                            }
                            DropdownMenuItem(
                                text = { Text("Export chat") },
                                leadingIcon = { Icon(Icons.Default.IosShare, null) },
                                onClick = {
                                    menuOpen = false
                                    scope.launch {
                                        runCatching { exportChat(context, convo) { id -> directory.firstOrNull { it.id == id }?.display_name ?: "User $id" } }.onFailure { snackbar.showSnackbar("Export failed") }
                                    }
                                },
                            )
                        }
                    }
                }
            }
        },
        bottomBar = {
            Column {
            val mentionQuery = Regex("(?:^|\\s)@([a-zA-Z0-9._-]{0,32})$").find(input)?.groupValues?.get(1)
            val candidates = if (mentionQuery == null || editingMsg != null) emptyList() else {
                val pool: List<Pair<String, String>> = when (convo) {
                    is Convo.GroupChat -> group?.members?.map { it.username to it.display_name } ?: emptyList()
                    is Convo.Dm -> listOfNotNull(peer?.let { it.username to it.display_name })
                }
                pool.filter { (u, n) -> u != me?.username && (u.contains(mentionQuery, true) || n.contains(mentionQuery, true)) }.take(6)
            }
            if (candidates.isNotEmpty()) {
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    androidx.compose.foundation.lazy.LazyRow(
                        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(candidates) { (username, name) ->
                            AssistChip(
                                onClick = { input = input.dropLast((mentionQuery?.length ?: 0) + 1) + "@$username " },
                                label = { Text(name) },
                                leadingIcon = { Icon(Icons.Default.AlternateEmail, null, Modifier.size(16.dp)) },
                            )
                        }
                    }
                }
            }
            if (peerBlocked) BlockedBanner(title) { scope.launch { runCatching { ChatRepository.setBlocked((convo as Convo.Dm).peerId, false) } } } else Composer(
                recording = recording,
                recSecs = recSecs,
                onMic = onMic,
                onCancelRecording = { recording = false; recorder.cancel() },
                onSendRecording = sendRecording,
                input = input,
                onInput = { input = it; ChatRepository.sendTyping(convo) },
                encrypted = encrypted,
                uploading = uploading,
                replyTo = replyTo,
                editing = editingMsg,
                onCancelContext = { replyTo = null; if (editingMsg != null) { editingMsg = null; input = "" } },
                onAttach = { showAttachSheet = true },
                onSend = {
                    val edit = editingMsg
                    if (edit != null) {
                        ChatRepository.editMessage(edit, input)
                        editingMsg = null
                    } else {
                        ChatRepository.sendMessage(convo, input, replyToId = replyTo?.id)
                        replyTo = null
                    }
                    input = ""
                },
            )
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 10.dp),
            ) {
                if (typingName != null) item(key = "typing") { TypingBubble(typingName, convo is Convo.GroupChat) }
                items(rows, key = { r -> if (r is ChatRow.Msg) (r.msg.clientId ?: "m${r.msg.id}") else "d${(r as ChatRow.Day).label}" }) { row ->
                    when (row) {
                        is ChatRow.Day -> DayChip(row.label)
                        is ChatRow.Msg -> SwipeToReply(
                            enabled = row.msg.deleted_at == null && row.msg.id > 0 && editingMsg == null,
                            onReply = { replyTo = row.msg },
                        ) { MessageBubble(
                            msg = row.msg,
                            isMine = row.msg.sender_id == me?.id,
                            isGroup = convo is Convo.GroupChat,
                            firstOfRun = row.firstOfRun,
                            lastOfRun = row.lastOfRun,
                            saved = savedIds.contains(row.msg.id),
                            seenBy = group?.let { g -> groupReads[g.id]?.count { (uid, last) -> uid != me?.id && last >= row.msg.id } } ?: 0,
                            myId = me?.id,
                            myUsername = me?.username ?: "",
                            knownUsernames = knownUsernames,
                            onOpenThread = { threadRoot = row.msg },
                            onClick = { if (row.msg.failed) ChatRepository.retryMessage(convo, row.msg) },
                            onLongClick = { if (row.msg.deleted_at == null && row.msg.id > 0) actionsFor = row.msg },
                            onReact = { emoji -> ChatRepository.reactToMessage(row.msg, emoji) },
                            onOpenFile = { f ->
                                if (f.mime.startsWith("image/")) lightboxFile = f
                                else scope.launch { runCatching { openAttachment(context, f) }.onFailure { snackbar.showSnackbar("Couldn't open the file") } }
                            },
                        ) }
                    }
                }
                if (convo.key in loadingOlder) {
                    item(key = "older") {
                        Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp) }
                    }
                }
                if (messages.isEmpty()) {
                    item(key = "empty") { EmptyChat(title, encrypted) }
                }
            }
            val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 4 } }
            AnimatedVisibility(
                visible = showJump,
                enter = scaleIn() + fadeIn(),
                exit = scaleOut() + fadeOut(),
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) {
                SmallFloatingActionButton(
                    onClick = { scope.launch { listState.animateScrollToItem(0) } },
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    shape = CircleShape,
                ) { Icon(Icons.Default.KeyboardArrowDown, "Jump to latest") }
            }
        }
    }

    val target = actionsFor
    if (target != null) {
        MessageActionsSheet(
            msg = target,
            isMine = target.sender_id == me?.id,
            saved = savedIds.contains(target.id),
            myId = me?.id,
            onDismiss = { actionsFor = null },
            onReact = { ChatRepository.reactToMessage(target, it); actionsFor = null },
            onReply = { replyTo = target; editingMsg = null; actionsFor = null },
            onCopy = {
                clipboard.setText(AnnotatedString(target.decryptedContent ?: target.content))
                actionsFor = null
                scope.launch { snackbar.showSnackbar("Copied") }
            },
            onEdit = { editingMsg = target; replyTo = null; input = target.decryptedContent ?: target.content; actionsFor = null },
            onPin = { ChatRepository.pinMessage(target, target.pinned_at == null); actionsFor = null },
            onSave = { scope.launch { ChatRepository.toggleSave(target) }; actionsFor = null },
            onForward = { forwardMsg = target; actionsFor = null },
            onThread = { threadRoot = target; actionsFor = null },
            canDelete = target.sender_id == me?.id || iAmModerator,
            onDelete = { deleteTarget = target; actionsFor = null },
        )
    }

    val lightbox = lightboxFile
    if (lightbox != null) {
        Dialog(onDismissRequest = { lightboxFile = null }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Box(Modifier.fillMaxSize().background(Color.Black).clickable { lightboxFile = null }) {
                AsyncImage(
                    model = SessionManager.api.fileUrl(lightbox.id),
                    contentDescription = lightbox.name,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(16.dp),
                )
                Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = { lightboxFile = null }) { Icon(Icons.Default.Close, "Close", tint = Color.White) }
                    Text(lightbox.name, color = Color.White, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    IconButton(onClick = { scope.launch { runCatching { openAttachment(context, lightbox) } } }) { Icon(Icons.Default.Download, "Save / open externally", tint = Color.White) }
                }
            }
        }
    }

    if (showPollDialog) {
        PollDialog(onDismiss = { showPollDialog = false }) { question, options, multi ->
            ChatRepository.sendMessage(convo, question, poll = ChatRepository.PollDraft(options, multi))
        }
    }
    threadRoot?.let { root -> ThreadSheet(convo, root, onDismiss = { threadRoot = null }) }
    if (confirmBlock && convo is Convo.Dm) {
        ConfirmDialog(
            title = "Block $title?",
            message = "They won't be able to send you direct messages, and you won't be able to send them any. Group chats and calls are unaffected. You can unblock them any time.",
            confirmLabel = "Block",
            onConfirm = { scope.launch { runCatching { ChatRepository.setBlocked(convo.peerId, true) }.onFailure { snackbar.showSnackbar("Couldn't block") } } },
            onDismiss = { confirmBlock = false },
        )
    }

    forwardMsg?.let { msg ->
        ForwardDialog(
            groups = groups,
            people = directory.filter { it.id != me?.id && !it.disabled && !it.deleted },
            onDismiss = { forwardMsg = null },
            onPick = { target ->
                ChatRepository.sendMessage(target, msg.decryptedContent ?: msg.content, fileId = msg.file_id)
                forwardMsg = null
                scope.launch { snackbar.showSnackbar("Forwarded") }
            },
        )
    }

    deleteTarget?.let { msg ->
        ConfirmDialog(
            title = "Delete message?",
            message = "It will be removed for everyone in this chat.",
            confirmLabel = "Delete",
            onConfirm = { ChatRepository.deleteMessage(msg) },
            onDismiss = { deleteTarget = null },
        )
    }
}

/** Exports a readable, decrypted transcript (the server only has ciphertext for encrypted chats). */
private suspend fun exportChat(context: android.content.Context, convo: Convo, nameOf: (Long) -> String) {
    val dest = ChatRepository.exportTranscript(convo, nameOf)
    val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", dest)
    val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(android.content.Intent.EXTRA_STREAM, uri)
        addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    context.startActivity(android.content.Intent.createChooser(intent, "Export chat").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
}

@Composable
private fun EmptyChat(title: String, encrypted: Boolean) {
    Column(Modifier.fillMaxWidth().padding(vertical = 48.dp, horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(64.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.WavingHand, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
        }
        Spacer(Modifier.height(12.dp))
        Text("Say hello to $title", style = MaterialTheme.typography.titleMedium)
        Text(
            if (encrypted) "Messages here are end-to-end encrypted." else "Messages stay on your own server.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun DayChip(label: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 12.dp, vertical = 5.dp),
        )
    }
}

@Composable
private fun TypingBubble(name: String, isGroup: Boolean) {
    val t = rememberInfiniteTransition(label = "typing")
    Row(Modifier.padding(start = 6.dp, top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            repeat(3) { i ->
                val a by t.animateFloat(0.25f, 1f, infiniteRepeatable(tween(600, delayMillis = i * 150), RepeatMode.Reverse), label = "dot$i")
                Box(Modifier.size(7.dp).alpha(a).clip(CircleShape).background(MaterialTheme.colorScheme.onSurfaceVariant))
            }
        }
        if (isGroup) Text("  $name", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun nameColor(name: String): Color {
    val palette = listOf(Color(0xFF60A5FA), Color(0xFFF472B6), Color(0xFF34D399), Color(0xFFFBBF24), Color(0xFFA78BFA), Color(0xFFF87171), Color(0xFF22D3EE))
    return palette[kotlin.math.abs(name.hashCode()) % palette.size]
}

private fun displayText(m: Message): String = when {
    m.deleted_at != null -> "This message was deleted"
    m.is_encrypted -> m.decryptedContent ?: "Decrypting…"
    else -> m.content
}

private val tokenRegex = Regex("(https?://\\S+)|(@[a-zA-Z0-9._-]{2,32})")

/** Links and @mentions (of real members; your own is highlighted). */
private fun richText(text: String, myUsername: String, known: List<String>, linkColor: Color, mentionColor: Color): AnnotatedString =
    buildAnnotatedString {
        var last = 0
        for (m in tokenRegex.findAll(text)) {
            append(text.substring(last, m.range.first))
            val v = m.value
            when {
                v.startsWith("http") -> withStyle(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)) { append(v) }
                known.any { it.equals(v.drop(1), true) } -> {
                    val mine = v.drop(1).equals(myUsername, true)
                    withStyle(SpanStyle(color = mentionColor, fontWeight = FontWeight.SemiBold, background = if (mine) mentionColor.copy(alpha = 0.18f) else Color.Unspecified)) { append(v) }
                }
                else -> append(v)
            }
            last = m.range.last + 1
        }
        append(text.substring(last))
    }

@Composable
private fun MessageBubble(
    msg: Message,
    isMine: Boolean,
    isGroup: Boolean,
    firstOfRun: Boolean,
    lastOfRun: Boolean,
    saved: Boolean,
    seenBy: Int = 0,
    myId: Long?,
    myUsername: String,
    knownUsernames: List<String>,
    onOpenThread: () -> Unit = {},
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onReact: (String) -> Unit,
    onOpenFile: (FileBrief) -> Unit,
) {
    val context = LocalContext.current
    val big = 20.dp
    val small = 6.dp
    val shape = if (isMine) RoundedCornerShape(big, if (firstOfRun) big else small, if (lastOfRun) small else small, big)
    else RoundedCornerShape(if (firstOfRun) big else small, big, big, if (lastOfRun) small else small)
    val deleted = msg.deleted_at != null
    val bg = when {
        deleted -> MaterialTheme.colorScheme.surfaceContainer
        isMine -> MaterialTheme.colorScheme.primary
        // On light themes a tinted bubble disappears into the page; use white.
        MaterialTheme.colorScheme.background.luminance() > 0.5f -> MaterialTheme.colorScheme.surfaceContainerLowest
        else -> MaterialTheme.colorScheme.surfaceContainerHigh
    }
    val fg = if (isMine && !deleted) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    val meta = fg.copy(alpha = 0.7f)
    val image = msg.file?.takeIf { it.mime.startsWith("image/") && it.mime != "image/svg+xml" }

    Column(
        Modifier.fillMaxWidth().padding(top = if (firstOfRun) 8.dp else 2.dp),
        horizontalAlignment = if (isMine) Alignment.End else Alignment.Start,
    ) {
        Row(verticalAlignment = Alignment.Bottom) {
            if (isGroup && !isMine) {
                if (lastOfRun) Avatar(msg.sender?.display_name ?: "?", msg.sender?.avatar_file_id, size = 30)
                else Spacer(Modifier.width(30.dp))
                Spacer(Modifier.width(6.dp))
            }
            Column(
                Modifier
                    .widthIn(max = 300.dp)
                    .clip(shape)
                    .background(bg)
                    .then(if (deleted) Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape) else Modifier)
                    .combinedClickable(onClick = onClick, onLongClick = onLongClick)
                    .padding(if (image != null && msg.reply_to == null) 4.dp else 0.dp),
            ) {
                if (isGroup && !isMine && firstOfRun) {
                    val name = msg.sender?.display_name ?: "Unknown"
                    Text(name, style = MaterialTheme.typography.labelLarge, color = nameColor(name), modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp))
                }
                msg.reply_to?.let { r ->
                    Row(
                        Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp).clip(MaterialTheme.shapes.small)
                            .background(if (isMine) Color.White.copy(alpha = 0.16f) else MaterialTheme.colorScheme.surfaceContainerHighest)
                            .height(IntrinsicSize.Min),
                    ) {
                        Box(Modifier.width(3.dp).fillMaxHeight().background(if (isMine) Color.White else MaterialTheme.colorScheme.primary))
                        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                            Text(r.sender?.display_name ?: "Message", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = if (isMine) fg else MaterialTheme.colorScheme.primary)
                            Text(
                                when {
                                    r.deleted -> "Deleted message"
                                    r.is_encrypted -> "Encrypted message"
                                    r.content.isBlank() && r.has_file -> "Attachment"
                                    else -> r.content
                                },
                                style = MaterialTheme.typography.bodySmall, color = meta, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                if (!deleted) msg.file?.let { f ->
                    if (image != null) {
                        AsyncImage(
                            model = SessionManager.api.fileUrl(f.id),
                            contentDescription = f.name,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier.padding(top = if (msg.reply_to != null) 6.dp else 0.dp)
                                .widthIn(min = 180.dp, max = 292.dp).heightIn(min = 120.dp, max = 320.dp)
                                .clip(RoundedCornerShape(16.dp))
                                .combinedClickable(onClick = { onOpenFile(f) }, onLongClick = onLongClick),
                        )
                    } else if (f.mime.startsWith("audio/")) {
                        AudioMessage(f, fg, meta)
                    } else {
                        Row(
                            Modifier.padding(start = 8.dp, end = 8.dp, top = 8.dp).widthIn(min = 200.dp).clip(MaterialTheme.shapes.medium)
                                .background(if (isMine) Color.White.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surfaceContainerHighest)
                                .combinedClickable(onClick = { onOpenFile(f) }, onLongClick = onLongClick)
                                .padding(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.size(38.dp).clip(MaterialTheme.shapes.small).background(if (isMine) Color.White.copy(alpha = 0.2f) else MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                                Icon(Icons.AutoMirrored.Filled.InsertDriveFile, null, tint = if (isMine) fg else MaterialTheme.colorScheme.primary)
                            }
                            Column(Modifier.padding(start = 10.dp)) {
                                Text(f.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(humanFileSize(f.size), style = MaterialTheme.typography.labelSmall, color = meta)
                            }
                        }
                    }
                }
                val poll = msg.poll?.takeIf { !deleted }
                if (poll != null) PollBubble(poll, myId, canClose = isMine, fg = fg, meta = meta)
                val text = displayText(msg)
                val hasText = poll == null && (deleted || text.isNotBlank())
                Row(
                    Modifier.padding(start = 12.dp, end = 10.dp, top = if (hasText) 7.dp else 2.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    if (hasText) {
                        Text(
                            if (deleted) AnnotatedString(text) else richText(text, myUsername, knownUsernames, if (isMine) fg else MaterialTheme.colorScheme.primary, if (isMine) fg else MaterialTheme.colorScheme.primary),
                            color = if (deleted) MaterialTheme.colorScheme.onSurfaceVariant else fg,
                            style = MaterialTheme.typography.bodyLarge.copy(fontStyle = if (deleted) androidx.compose.ui.text.font.FontStyle.Italic else null),
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        if (msg.pinned_at != null) Icon(Icons.Default.PushPin, "Pinned", Modifier.size(11.dp), tint = meta)
                        if (saved) Icon(Icons.Default.Bookmark, "Saved", Modifier.size(11.dp), tint = meta)
                        if (msg.is_encrypted && !deleted) Icon(Icons.Default.Lock, "Encrypted", Modifier.size(11.dp), tint = meta)
                        if (msg.edited_at != null && !deleted) Text("edited", style = MaterialTheme.typography.labelSmall, color = meta)
                        Text(clockTime(msg.sent_at), style = MaterialTheme.typography.labelSmall, color = meta)
                        if (isMine && !deleted) {
                            when {
                                msg.failed -> Icon(Icons.Default.ErrorOutline, "Failed", Modifier.size(14.dp), tint = if (isMine) fg else MaterialTheme.colorScheme.error)
                                msg.pending -> Icon(Icons.Default.Schedule, "Sending", Modifier.size(13.dp), tint = meta)
                                msg.read_at != null -> Icon(Icons.Default.DoneAll, "Read", Modifier.size(15.dp), tint = if (isMine) Color(0xFFBFF4FF) else MaterialTheme.colorScheme.primary)
                                isGroup && seenBy > 0 -> {
                                    Icon(Icons.Default.DoneAll, "Seen by $seenBy", Modifier.size(15.dp), tint = Color(0xFFBFF4FF))
                                    Text("$seenBy", style = MaterialTheme.typography.labelSmall, color = meta)
                                }
                                msg.delivered_at != null || isGroup -> Icon(Icons.Default.DoneAll, "Delivered", Modifier.size(15.dp), tint = meta)
                                else -> Icon(Icons.Default.Done, "Sent", Modifier.size(15.dp), tint = meta)
                            }
                        }
                    }
                }
            }
        }
        if (msg.failed) {
            Text(
                "Not sent · tap to retry", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 3.dp, end = 4.dp).clickable(onClick = onClick),
            )
        }
        if (msg.thread_count > 0 && !deleted) {
            TextButton(onClick = onOpenThread, contentPadding = PaddingValues(horizontal = 6.dp, vertical = 0.dp)) {
                Icon(Icons.Default.Forum, null, Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text("${msg.thread_count} ${if (msg.thread_count == 1) "reply" else "replies"}", style = MaterialTheme.typography.labelMedium)
            }
        }
        val reactions = msg.reactions.orEmpty().groupBy { it.emoji }
        if (reactions.isNotEmpty() && !deleted) {
            Row(
                Modifier.padding(top = 3.dp, start = if (isGroup && !isMine) 36.dp else 0.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                reactions.forEach { (emoji, list) ->
                    val mine = list.any { it.user_id == myId }
                    Row(
                        Modifier.clip(CircleShape)
                            .background(if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh)
                            .border(1.dp, if (mine) MaterialTheme.colorScheme.primary else Color.Transparent, CircleShape)
                            .clickable { onReact(emoji) }
                            .padding(horizontal = 8.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(emoji, style = MaterialTheme.typography.bodyMedium)
                        if (list.size > 1) Text(" ${list.size}", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(
    recording: Boolean,
    recSecs: Int,
    onMic: () -> Unit,
    onCancelRecording: () -> Unit,
    onSendRecording: () -> Unit,
    input: String,
    onInput: (String) -> Unit,
    encrypted: Boolean,
    uploading: Boolean,
    replyTo: Message?,
    editing: Message?,
    onCancelContext: () -> Unit,
    onAttach: () -> Unit,
    onSend: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.navigationBarsPadding().imePadding()) {
            AnimatedVisibility(replyTo != null || editing != null, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                val ctx = editing ?: replyTo
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp).height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.width(3.dp).fillMaxHeight().clip(CircleShape).background(MaterialTheme.colorScheme.primary))
                    Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                        Text(
                            if (editing != null) "Editing message" else "Replying to ${ctx?.sender?.display_name ?: "message"}",
                            style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                        )
                        Text(ctx?.let { displayText(it) } ?: "", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = onCancelContext) { Icon(Icons.Default.Close, "Cancel") }
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
                Row(
                    Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    IconButton(onClick = onAttach, enabled = !uploading && editing == null) {
                        if (uploading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Default.AttachFile, "Attach file", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Box(Modifier.weight(1f).padding(top = 13.dp, bottom = 13.dp, end = 14.dp)) {
                        if (input.isEmpty()) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (encrypted) Icon(Icons.Default.Lock, null, Modifier.size(14.dp).padding(end = 4.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(if (encrypted) "Encrypted message" else "Message", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        BasicTextField(
                            value = input,
                            onValueChange = onInput,
                            maxLines = 6,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                val canSend = input.isNotBlank()
                if (recording) {
                    Row(Modifier.height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.FiberManualRecord, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.error)
                        Text(" %d:%02d".format(recSecs / 60, recSecs % 60), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(end = 4.dp))
                        IconButton(onClick = onCancelRecording) { Icon(Icons.Default.Close, "Cancel recording") }
                        FilledIconButton(onClick = onSendRecording, modifier = Modifier.size(48.dp), shape = CircleShape) {
                            Icon(Icons.AutoMirrored.Filled.Send, "Send voice message")
                        }
                    }
                } else if (!canSend && editing == null) {
                    FilledIconButton(
                        onClick = onMic, enabled = !uploading, modifier = Modifier.size(48.dp), shape = CircleShape,
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primary),
                    ) { Icon(Icons.Default.Mic, "Record voice message") }
                } else FilledIconButton(
                    onClick = { if (canSend) onSend() },
                    enabled = canSend,
                    modifier = Modifier.size(48.dp),
                    shape = CircleShape,
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    ),
                ) { Icon(if (editing != null) Icons.Default.Check else Icons.AutoMirrored.Filled.Send, if (editing != null) "Save edit" else "Send") }
            }
        }
    }
}

@Composable
private fun MessageActionsSheet(
    msg: Message,
    isMine: Boolean,
    saved: Boolean,
    myId: Long?,
    onDismiss: () -> Unit,
    onReact: (String) -> Unit,
    onReply: () -> Unit,
    onCopy: () -> Unit,
    onEdit: () -> Unit,
    onPin: () -> Unit,
    onSave: () -> Unit,
    onForward: () -> Unit,
    onThread: () -> Unit,
    canDelete: Boolean,
    onDelete: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(bottom = 24.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                QuickReactions.forEach { emoji ->
                    val mine = msg.reactions.orEmpty().any { it.emoji == emoji && it.user_id == myId }
                    Box(
                        Modifier.size(48.dp).clip(CircleShape)
                            .background(if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh)
                            .clickable { onReact(emoji) },
                        contentAlignment = Alignment.Center,
                    ) { Text(emoji, style = MaterialTheme.typography.titleLarge) }
                }
            }
            Spacer(Modifier.height(8.dp))
            SheetAction(Icons.AutoMirrored.Filled.Reply, "Reply", onReply)
            SheetAction(Icons.Default.Forum, "Reply in thread", onThread)
            if ((msg.decryptedContent ?: msg.content).isNotBlank()) SheetAction(Icons.Default.ContentCopy, "Copy text", onCopy)
            if (isMine && !msg.is_encrypted && msg.file == null) SheetAction(Icons.Default.Edit, "Edit", onEdit)
            SheetAction(Icons.Outlined.PushPin, if (msg.pinned_at != null) "Unpin" else "Pin", onPin)
            SheetAction(if (saved) Icons.Default.Bookmark else Icons.Outlined.BookmarkBorder, if (saved) "Remove from saved" else "Save", onSave)
            if ((msg.decryptedContent ?: msg.content).isNotBlank() || msg.file != null) SheetAction(Icons.Default.Shortcut, "Forward", onForward)
            if (canDelete) SheetAction(Icons.Default.DeleteOutline, if (isMine) "Delete" else "Delete (moderator)", onDelete, danger = true)
        }
    }
}

@Composable
private fun SheetAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit, danger: Boolean = false) {
    val color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = color)
        Spacer(Modifier.width(18.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = color)
    }
}

private fun queryFileName(context: android.content.Context, uri: android.net.Uri): String? {
    var name: String? = null
    context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0 && cursor.moveToFirst()) name = cursor.getString(idx)
    }
    return name
}


@Composable
private fun ForwardDialog(groups: List<Group>, people: List<User>, onDismiss: () -> Unit, onPick: (Convo) -> Unit) {
    var query by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Forward to…") },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text("Search people and groups") }, modifier = Modifier.fillMaxWidth())
                androidx.compose.foundation.lazy.LazyColumn(Modifier.heightIn(max = 340.dp).padding(top = 8.dp)) {
                    items(groups.filter { it.name.contains(query, true) }) { g ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(Convo.GroupChat(g.id)) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(g.name, g.avatar_file_id, size = 36)
                            Text(g.name, Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    items(people.filter { it.display_name.contains(query, true) || it.username.contains(query, true) }) { u ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(Convo.Dm(u.id)) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(u.display_name, u.avatar_file_id, size = 36)
                            Text(u.display_name, Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
