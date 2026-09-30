package com.videocall.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Login
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.call.CallRepository
import com.videocall.mobile.net.PrivateRoom
import com.videocall.mobile.net.User
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.ConfirmDialog
import com.videocall.mobile.ui.components.EmptyState
import com.videocall.mobile.ui.components.HeaderAction
import com.videocall.mobile.ui.components.PrimaryButton
import com.videocall.mobile.ui.components.ScreenHeader
import com.videocall.mobile.ui.components.SectionHeader
import com.videocall.mobile.ui.util.rememberCallLauncher

/**
 * Private rooms — standalone calls joined by a share code, optionally gated
 * by a passcode, an invite list and/or host approval (same as the web Rooms
 * page). Joining goes through CallRepository.joinPrivateRoom ("priv:<code>").
 */
@Composable
fun RoomsScreen(contentPadding: PaddingValues = PaddingValues()) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var rooms by remember { mutableStateOf<List<PrivateRoom>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var showCreate by remember { mutableStateOf(false) }
    var showJoin by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pendingJoin by remember { mutableStateOf<Triple<String, String, String?>?>(null) } // code, name, passcode
    var deleteTarget by remember { mutableStateOf<PrivateRoom?>(null) }
    val snackbar = remember { SnackbarHostState() }

    val launchJoin = rememberCallLauncher(
        onDenied = { android.widget.Toast.makeText(context, "Microphone/camera permission is needed to join a call", android.widget.Toast.LENGTH_SHORT).show() },
        onStart = { video -> pendingJoin?.let { (code, name, passcode) -> CallRepository.joinPrivateRoom(context, code, name, passcode, video) } },
    )

    suspend fun refresh() {
        runCatching { SessionManager.api.myRooms() }.onSuccess { rooms = it }.onFailure { error = it.message }
    }

    LaunchedEffect(Unit) { refresh(); loading = false }

    Box(Modifier.fillMaxSize().padding(bottom = contentPadding.calculateBottomPadding())) {
        Column(Modifier.fillMaxSize()) {
            ScreenHeader("Rooms", subtitle = "Private calls you can share with a code") {
                HeaderAction(Icons.AutoMirrored.Filled.Login, "Join with code") { showJoin = true }
                HeaderAction(Icons.Default.Add, "New room") { showCreate = true }
            }
            if (loading) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                return@Column
            }
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
                modifier = Modifier.fillMaxSize(),
            ) {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    item { RoomsHero(onCreate = { showCreate = true }, onJoin = { showJoin = true }) }
                    if (rooms.isEmpty()) {
                        item {
                            EmptyState(
                                icon = Icons.Default.MeetingRoom,
                                title = "No rooms yet",
                                subtitle = "Rooms you create show up here, ready to start any time",
                            )
                        }
                    } else {
                        item { SectionHeader("Your rooms") }
                        items(rooms, key = { it.id }) { room ->
                            RoomCard(
                                room,
                                onStart = { pendingJoin = Triple(room.id, room.name, null); launchJoin(true) },
                                onShare = {
                                    val shareText = "Join my Vision Call room \"${room.name}\" with code ${room.id}"
                                    val intent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                                        type = "text/plain"
                                        putExtra(android.content.Intent.EXTRA_TEXT, shareText)
                                    }
                                    context.startActivity(android.content.Intent.createChooser(intent, "Share room code").addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
                                },
                                onCopy = {
                                    clipboard.setText(AnnotatedString(room.id))
                                    scope.launch { snackbar.showSnackbar("Room code copied") }
                                },
                                onDelete = { deleteTarget = room },
                            )
                        }
                    }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }

    if (showCreate) {
        CreateRoomSheet(
            onDismiss = { showCreate = false },
            onCreated = { room ->
                showCreate = false
                scope.launch { refresh(); snackbar.showSnackbar("Room created — code ${room.id}") }
            },
        )
    }
    if (showJoin) {
        JoinRoomSheet(
            onDismiss = { showJoin = false },
            onJoin = { room, passcode ->
                showJoin = false
                pendingJoin = Triple(room.id, room.name, passcode)
                launchJoin(true)
            },
        )
    }
    error?.let {
        AlertDialog(onDismissRequest = { error = null }, confirmButton = { TextButton(onClick = { error = null }) { Text("OK") } }, title = { Text("Something went wrong") }, text = { Text(it) })
    }
    deleteTarget?.let { room ->
        ConfirmDialog(
            title = "Delete \"${room.name}\"?",
            message = "This permanently deletes the room for everyone. This can't be undone.",
            confirmLabel = "Delete",
            onConfirm = {
                scope.launch {
                    runCatching { SessionManager.api.deleteRoom(room.id) }.onFailure { error = it.message }
                    refresh()
                }
            },
            onDismiss = { deleteTarget = null },
        )
    }
}

@Composable
private fun RoomsHero(onCreate: () -> Unit, onJoin: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    Column(
        Modifier.fillMaxWidth().padding(16.dp).clip(MaterialTheme.shapes.extraLarge)
            .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.30f), accent.copy(alpha = 0.08f))))
            .padding(20.dp),
    ) {
        Icon(Icons.Default.VideoCall, null, tint = accent, modifier = Modifier.size(32.dp))
        Spacer(Modifier.height(10.dp))
        Text("Meet in a private room", style = MaterialTheme.typography.titleLarge)
        Text(
            "Share a code instead of a group — add a passcode, an invite list or host approval.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = onCreate, shape = MaterialTheme.shapes.medium) {
                Icon(Icons.Default.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("New room")
            }
            FilledTonalButton(onClick = onJoin, shape = MaterialTheme.shapes.medium) {
                Icon(Icons.Default.Tag, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Join with code")
            }
        }
    }
}

@Composable
private fun RoomCard(room: PrivateRoom, onStart: () -> Unit, onShare: () -> Unit, onCopy: () -> Unit, onDelete: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).clickable(onClick = onStart),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(44.dp).clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.MeetingRoom, null, tint = MaterialTheme.colorScheme.primary) }
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text(room.name, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    Text(room.id, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FilledIconButton(onClick = onStart) { Icon(Icons.Default.Videocam, "Start") }
            }
            if (room.scheduled_at.isNotBlank() || !room.is_owner) {
                val whenText = runCatching {
                    java.time.format.DateTimeFormatter.ofPattern("EEE d MMM, HH:mm")
                        .format(java.time.Instant.parse(room.scheduled_at).atZone(java.time.ZoneId.systemDefault()))
                }.getOrNull()
                Text(
                    listOfNotNull(
                        whenText?.let { "Scheduled · $it" },
                        if (!room.is_owner) "Invited by ${room.owner?.display_name ?: "someone"}" else null,
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 10.dp),
                )
            }
            if (room.require_passcode || room.require_approval) {
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (room.require_passcode) Chip(Icons.Default.Lock, "Passcode")
                    if (room.require_approval) Chip(Icons.Default.VerifiedUser, "Host approval")
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outlineVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onShare) { Icon(Icons.Default.Share, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Share") }
                TextButton(onClick = onCopy) { Icon(Icons.Default.ContentCopy, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text("Copy code") }
                Spacer(Modifier.weight(1f))
                if (room.is_owner) {
                    IconButton(onClick = onDelete) { Icon(Icons.Default.DeleteOutline, "Delete", tint = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

@Composable
private fun Chip(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String) {
    Row(
        Modifier.clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHighest).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(5.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun CreateRoomSheet(onDismiss: () -> Unit, onCreated: (PrivateRoom) -> Unit) {
    val scope = rememberCoroutineScope()
    val me by SessionManager.me.collectAsState()
    var name by remember { mutableStateOf("") }
    var passcode by remember { mutableStateOf("") }
    var approval by remember { mutableStateOf(false) }
    var users by remember { mutableStateOf<List<User>>(emptyList()) }
    val invited = remember { mutableStateListOf<Long>() }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var scheduled by remember { mutableStateOf<java.time.LocalDateTime?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var pickedDate by remember { mutableStateOf<java.time.LocalDate?>(null) }
    LaunchedEffect(Unit) { users = runCatching { SessionManager.api.users() }.getOrDefault(emptyList()).filter { it.id != me?.id && !it.disabled } }

    if (showDatePicker) {
        val dateState = rememberDatePickerState(initialSelectedDateMillis = System.currentTimeMillis())
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    dateState.selectedDateMillis?.let { pickedDate = java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneOffset.UTC).toLocalDate() }
                    showDatePicker = false
                }) { Text("Next") }
            },
            dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("Cancel") } },
        ) { DatePicker(dateState) }
    }
    pickedDate?.let { date ->
        val timeState = rememberTimePickerState(initialHour = (java.time.LocalTime.now().hour + 1) % 24, initialMinute = 0, is24Hour = true)
        AlertDialog(
            onDismissRequest = { pickedDate = null },
            title = { Text("Start time") },
            text = { TimePicker(timeState) },
            confirmButton = {
                TextButton(onClick = {
                    scheduled = java.time.LocalDateTime.of(date, java.time.LocalTime.of(timeState.hour, timeState.minute))
                    pickedDate = null
                }) { Text("Set") }
            },
            dismissButton = { TextButton(onClick = { pickedDate = null }) { Text("Cancel") } },
        )
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("New room", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(name, { name = it }, label = { Text("Room name") }, placeholder = { Text("${me?.display_name ?: "My"}'s room") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium)
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                passcode, { passcode = it }, label = { Text("Passcode (optional)") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
            )
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth().clickable { showDatePicker = true }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Schedule for later", style = MaterialTheme.typography.bodyLarge)
                    Text(
                        scheduled?.format(java.time.format.DateTimeFormatter.ofPattern("EEE d MMM, HH:mm")) ?: "Starts now — invited people see it in Rooms",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (scheduled != null) IconButton(onClick = { scheduled = null }) { Icon(Icons.Default.Close, "Clear time") }
                else Icon(Icons.Default.Schedule, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth().clickable { approval = !approval }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Host approval", style = MaterialTheme.typography.bodyLarge)
                    Text("You let each person in", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked = approval, onCheckedChange = { approval = it })
            }
            if (users.isNotEmpty()) {
                Text("Invite only (optional)", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 8.dp, bottom = 6.dp))
                Text(
                    if (invited.isEmpty()) "Anyone with the code can join" else "Only ${invited.size} invited ${if (invited.size == 1) "person" else "people"} can join",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                LazyRow(Modifier.padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(users, key = { it.id }) { u ->
                        val on = u.id in invited
                        Column(
                            Modifier.width(64.dp).clip(MaterialTheme.shapes.medium).clickable { if (on) invited.remove(u.id) else invited.add(u.id) }.padding(4.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Box {
                                Avatar(u.display_name, u.avatar_file_id, size = 48)
                                if (on) Box(
                                    Modifier.size(20.dp).align(Alignment.BottomEnd).clip(MaterialTheme.shapes.extraLarge).background(MaterialTheme.colorScheme.primary),
                                    contentAlignment = Alignment.Center,
                                ) { Icon(Icons.Default.Check, null, tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(14.dp)) }
                            }
                            Text(u.display_name, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                        }
                    }
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(bottom = 8.dp)) }
            PrimaryButton("Create room", busy = busy, onClick = {
                busy = true
                error = null
                scope.launch {
                    runCatching { SessionManager.api.createRoom(name.trim(), passcode.trim().ifBlank { null }, approval, invited.toList(), scheduled?.atZone(java.time.ZoneId.systemDefault())?.toInstant()?.toString()) }
                        .onSuccess(onCreated)
                        .onFailure { error = it.message ?: "Couldn't create the room" }
                    busy = false
                }
            })
        }
    }
}

@Composable
private fun JoinRoomSheet(onDismiss: () -> Unit, onJoin: (PrivateRoom, String?) -> Unit) {
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var passcode by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<PrivateRoom?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("Join a room", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                code, { code = it.uppercase().filter { c -> c.isLetterOrDigit() }.take(12); found = null; error = null },
                label = { Text("Room code") }, singleLine = true,
                textStyle = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
            )
            found?.let { room ->
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(room.owner?.display_name ?: room.name, room.owner?.avatar_file_id, size = 40)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(room.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "Hosted by ${room.owner?.display_name ?: "unknown"}" + if (room.require_approval) " · host lets you in" else "",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (room.require_passcode) {
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        passcode, { passcode = it }, label = { Text("Passcode") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
                    )
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
            Spacer(Modifier.height(16.dp))
            val room = found
            PrimaryButton(
                if (room == null) "Find room" else "Join",
                enabled = code.length >= 4 && (room == null || !room.require_passcode || passcode.isNotBlank()),
                busy = busy,
                onClick = {
                    if (room != null) {
                        onJoin(room, passcode.ifBlank { null })
                        return@PrimaryButton
                    }
                    busy = true
                    scope.launch {
                        runCatching { SessionManager.api.getRoom(code) }
                            .onSuccess { found = it }
                            .onFailure { error = if ((it as? com.videocall.mobile.net.ApiException)?.status == 404) "No room with that code" else it.message }
                        busy = false
                    }
                },
            )
        }
    }
}
