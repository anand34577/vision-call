package com.videocall.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.chat.ChatRepository
import com.videocall.mobile.chat.Convo
import com.videocall.mobile.net.Group
import com.videocall.mobile.net.Message
import com.videocall.mobile.net.Poll
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.PrimaryButton
import com.videocall.mobile.ui.components.clockTime

/** A poll inside a chat bubble: tap an option to vote, tap again to undo. */
@Composable
fun PollBubble(poll: Poll, myId: Long?, canClose: Boolean, fg: Color, meta: Color) {
    val total = poll.options.sumOf { it.votes.size }
    val voters = poll.options.flatMap { it.votes }.toSet().size
    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp).widthIn(min = 220.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(poll.question, style = MaterialTheme.typography.titleSmall, color = fg)
        Text(
            (if (poll.closed) "Poll closed" else if (poll.multi) "Select one or more" else "Select one") + " · $voters ${if (voters == 1) "vote" else "votes"}",
            style = MaterialTheme.typography.labelSmall, color = meta,
        )
        poll.options.forEach { o ->
            val pct = if (total == 0) 0 else Math.round(o.votes.size * 100f / total)
            val picked = myId != null && o.votes.contains(myId)
            val shape = RoundedCornerShape(10.dp)
            Box(
                Modifier.fillMaxWidth().clip(shape)
                    .border(1.dp, if (picked) fg else fg.copy(alpha = 0.3f), shape)
                    .clickable(enabled = !poll.closed) { ChatRepository.votePoll(poll.id, o.id) },
            ) {
                Box(Modifier.matchParentSize().fillMaxWidth(pct / 100f).background(fg.copy(alpha = 0.18f)))
                Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text((if (picked) "✓ " else "") + o.text, color = fg, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    Text("${o.votes.size} · $pct%", color = meta, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        if (canClose && !poll.closed) {
            TextButton(onClick = { ChatRepository.closePoll(poll.id) }, contentPadding = PaddingValues(0.dp)) {
                Icon(Icons.Default.Lock, null, Modifier.size(14.dp), tint = fg)
                Spacer(Modifier.width(4.dp))
                Text("Close poll", color = fg, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/** Create-a-poll dialog: a question and 2-10 options. */
@Composable
fun PollDialog(onDismiss: () -> Unit, onCreate: (question: String, options: List<String>, multi: Boolean) -> Unit) {
    var question by remember { mutableStateOf("") }
    val options = remember { mutableStateListOf("", "") }
    var multi by remember { mutableStateOf(false) }
    val cleaned = options.map { it.trim() }.filter { it.isNotEmpty() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Create a poll") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.heightIn(max = 420.dp)) {
                item {
                    OutlinedTextField(question, { question = it.take(300) }, label = { Text("Question") }, modifier = Modifier.fillMaxWidth())
                }
                items(options.size) { i ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            options[i], { options[i] = it.take(100) }, label = { Text("Option ${i + 1}") }, singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        if (options.size > 2) IconButton(onClick = { options.removeAt(i) }) { Icon(Icons.Default.Close, "Remove option ${i + 1}") }
                    }
                }
                if (options.size < 10) item {
                    TextButton(onClick = { options.add("") }) { Icon(Icons.Default.Add, null); Spacer(Modifier.width(6.dp)); Text("Add option") }
                }
                item {
                    Row(Modifier.fillMaxWidth().clickable { multi = !multi }, verticalAlignment = Alignment.CenterVertically) {
                        Text("Allow multiple answers", Modifier.weight(1f))
                        Switch(multi, { multi = it })
                    }
                }
                item {
                    Text(
                        "Polls are visible to everyone in the chat, so they are not end-to-end encrypted.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(enabled = question.isNotBlank() && cleaned.size >= 2, onClick = { onCreate(question.trim(), cleaned, multi); onDismiss() }) { Text("Send poll") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** A message's thread: the first message and the replies under it, with a reply box. */
@Composable
fun ThreadSheet(convo: Convo, root: Message, onDismiss: () -> Unit) {
    val allMessages by ChatRepository.messages.collectAsState()
    val me by SessionManager.me.collectAsState()
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val replies = (allMessages[convo.key] ?: emptyList()).filter { it.thread_root_id == root.id }

    LaunchedEffect(root.id) { ChatRepository.loadThread(convo, root.id) }
    LaunchedEffect(replies.size) { if (replies.isNotEmpty()) listState.animateScrollToItem(replies.size - 1) }

    fun body(m: Message) = when {
        m.deleted_at != null -> "Message deleted"
        m.is_encrypted -> m.decryptedContent ?: "Decrypting…"
        else -> m.content.ifBlank { m.file?.name ?: "" }
    }

    @Composable
    fun Line(m: Message) {
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Avatar(m.sender?.display_name ?: "?", m.sender?.avatar_file_id, size = 32)
            Column(Modifier.padding(start = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(if (m.sender_id == me?.id) "You" else m.sender?.display_name ?: "Someone", style = MaterialTheme.typography.labelLarge)
                    Text("  " + clockTime(m.sent_at) + if (m.pending) " · sending…" else if (m.failed) " · not sent" else "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(body(m), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxHeight(0.85f).padding(horizontal = 16.dp).imePadding()) {
            Text("Thread", style = MaterialTheme.typography.titleLarge)
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Box(Modifier.padding(horizontal = 12.dp)) { Line(root) }
            }
            Text(
                "${replies.size} ${if (replies.size == 1) "reply" else "replies"}",
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            LazyColumn(Modifier.weight(1f), state = listState) {
                items(replies, key = { it.clientId ?: "m${it.id}" }) { Line(it) }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    input, { input = it }, placeholder = { Text("Reply in thread…") }, modifier = Modifier.weight(1f),
                    maxLines = 4, shape = RoundedCornerShape(24.dp),
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = { ChatRepository.sendMessage(convo, input, threadRootId = root.id); input = "" },
                    enabled = input.isNotBlank(),
                ) { Icon(Icons.AutoMirrored.Filled.Send, "Send reply") }
            }
        }
    }
}

/** Public channels anyone can join. */
@Composable
fun ChannelBrowserSheet(onDismiss: () -> Unit, onJoined: (Long) -> Unit) {
    val scope = rememberCoroutineScope()
    var channels by remember { mutableStateOf<List<Group>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var joining by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(Unit) {
        runCatching { SessionManager.api.publicGroups() }.onSuccess { channels = it }.onFailure { error = it.message ?: "Couldn't load channels" }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxHeight(0.7f).padding(bottom = 16.dp)) {
            Text("Browse channels", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(20.dp)) }
            val list = channels
            if (list == null && error == null) Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            if (list != null && list.isEmpty()) {
                Text(
                    "There are no other public channels to join right now. Create a group and switch on \"Public channel\".",
                    modifier = Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn {
                items(list ?: emptyList(), key = { it.id }) { g ->
                    ListItem(
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                        leadingContent = { Avatar(g.name, g.avatar_file_id, size = 44) },
                        headlineContent = { Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Default.Tag, null, Modifier.size(16.dp)); Text(g.name, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
                        supportingContent = { Text("${g.member_count} members" + if (g.topic.isNotBlank()) " · ${g.topic}" else "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        trailingContent = {
                            FilledTonalButton(enabled = joining == null, onClick = {
                                joining = g.id
                                scope.launch {
                                    runCatching { SessionManager.api.joinGroup(g.id) }
                                        .onSuccess { ChatRepository.loadGroups(); onDismiss(); onJoined(g.id) }
                                        .onFailure { error = it.message ?: "Couldn't join"; joining = null }
                                }
                            }) { Text(if (joining == g.id) "Joining…" else "Join") }
                        },
                    )
                }
            }
        }
    }
}

/** Shown instead of the message box while you have blocked the person. */
@Composable
fun BlockedBanner(name: String, onUnblock: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("You blocked $name. They can't message you.", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onUnblock) { Text("Unblock") }
        }
    }
}
