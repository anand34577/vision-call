package com.videocall.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.BookmarkBorder
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.chat.ChatRepository
import com.videocall.mobile.chat.Convo
import com.videocall.mobile.net.Message
import com.videocall.mobile.net.User
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.EmptyState
import com.videocall.mobile.ui.components.HeaderAction
import com.videocall.mobile.ui.components.PrimaryButton
import com.videocall.mobile.ui.components.ScreenHeader
import com.videocall.mobile.ui.components.SearchField
import com.videocall.mobile.ui.components.SectionHeader
import com.videocall.mobile.ui.components.UnreadBadge
import com.videocall.mobile.ui.components.shortTimestamp

private data class ConvoItem(
    val convo: Convo,
    val title: String,
    val avatarFileId: Long?,
    val status: String?,
    val last: Message?,
    val unread: Int,
    val isGroup: Boolean,
    val muted: Boolean = false,
    val archived: Boolean = false,
    val isChannel: Boolean = false,
)

/** The small icon in front of a preview line: photo, attachment or lock. */
fun previewIcon(m: Message?): androidx.compose.ui.graphics.vector.ImageVector? = when {
    m == null || m.deleted_at != null -> null
    m.file != null && (m.decryptedContent ?: m.content).isBlank() ->
        if (m.file.mime.startsWith("image/")) Icons.Default.Image else Icons.Default.AttachFile
    m.is_encrypted && m.decryptedContent == null -> Icons.Default.Lock
    else -> null
}

/** One messages preview line, the way the chat list shows it. */
fun previewText(m: Message?, myId: Long?, isGroup: Boolean): String {
    if (m == null) return ""
    val body = when {
        m.deleted_at != null -> "Message deleted"
        m.file != null && (m.decryptedContent ?: m.content).isBlank() -> if (m.file.mime.startsWith("image/")) "Photo" else m.file.name
        m.is_encrypted -> m.decryptedContent ?: "Encrypted message"
        else -> m.content
    }.replace('\n', ' ')
    return when {
        m.sender_id == myId -> "You: $body"
        isGroup -> "${m.sender?.display_name?.substringBefore(' ') ?: "Someone"}: $body"
        else -> body
    }
}

@Composable
fun ChatsListScreen(
    onOpenDm: (Long) -> Unit,
    onOpenGroup: (Long) -> Unit,
    onOpenSearch: () -> Unit,
    onOpenSaved: () -> Unit,
    onOpenPeople: () -> Unit,
    contentPadding: PaddingValues = PaddingValues(),
) {
    val scope = rememberCoroutineScope()
    var users by remember { mutableStateOf<List<User>>(emptyList()) }
    val groups by ChatRepository.groups.collectAsState()
    val unread by ChatRepository.unread.collectAsState()
    val messages by ChatRepository.messages.collectAsState()
    val prefs by ChatRepository.prefs.collectAsState()
    val directoryVersion by SessionManager.directoryVersion.collectAsState()
    var showArchived by remember { mutableStateOf(false) }
    val typing by ChatRepository.typingIn(Convo.Dm(0)).collectAsState()
    val presence by SessionManager.presence.collectAsState()
    val me by SessionManager.me.collectAsState()
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var showNewGroup by remember { mutableStateOf(false) }
    var showChannels by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }

    suspend fun refresh() {
        runCatching { SessionManager.api.users() }
            .onSuccess { users = it; loadError = null }
            .onFailure { loadError = it.message ?: "Couldn't load chats" }
        ChatRepository.loadGroups()
        ChatRepository.fetchRecent()
    }

    LaunchedEffect(Unit) {
        refresh()
        loading = false
    }
    // An admin added, renamed or removed someone: reload the people list.
    LaunchedEffect(directoryVersion) {
        if (directoryVersion > 0) runCatching { SessionManager.api.users() }.onSuccess { users = it }
    }

    val usersById = users.associateBy { it.id }
    val items = remember(users, groups, messages, unread, presence, me, prefs) {
        val out = mutableListOf<ConvoItem>()
        groups.forEach { g ->
            val c = Convo.GroupChat(g.id)
            out += ConvoItem(c, g.name, g.avatar_file_id, null, messages[c.key]?.lastOrNull(), unread[c.key] ?: 0, true, prefs[c.key]?.muted == true, prefs[c.key]?.archived == true, g.public)
        }
        users.filter { it.id != me?.id && !it.disabled }.forEach { u ->
            val c = Convo.Dm(u.id)
            val last = messages[c.key]?.lastOrNull()
            val count = unread[c.key] ?: 0
            if (last != null || count > 0) {
                out += ConvoItem(c, u.display_name, u.avatar_file_id, presence[u.id] ?: u.status, last, count, false, prefs[c.key]?.muted == true, prefs[c.key]?.archived == true)
            }
        }
        out.sortedWith(compareByDescending<ConvoItem> { it.last?.sent_at ?: "" }.thenBy { it.title.lowercase() })
    }
    val q = query.trim()
    val archivedCount = items.count { it.archived }
    val inView = items.filter { it.archived == showArchived }
    val visible = if (q.isBlank()) inView else inView.filter { it.title.contains(q, true) }
    val online = users.filter { it.id != me?.id && !it.disabled && (presence[it.id] ?: it.status) != "offline" }

    Column(Modifier.fillMaxSize().padding(bottom = contentPadding.calculateBottomPadding())) {
        ScreenHeader(if (showArchived) "Archived" else "Chats") {
            if (archivedCount > 0 || showArchived) {
                HeaderAction(if (showArchived) Icons.Default.Inbox else Icons.Default.Archive, if (showArchived) "Back to chats" else "Archived chats ($archivedCount)") { showArchived = !showArchived }
            }
            HeaderAction(Icons.Default.ManageSearch, "Search messages", onOpenSearch)
            HeaderAction(Icons.Outlined.BookmarkBorder, "Saved messages", onOpenSaved)
            HeaderAction(Icons.Default.Tag, "Browse channels") { showChannels = true }
            HeaderAction(Icons.Default.GroupAdd, "New group") { showNewGroup = true }
        }
        SearchField(query, { query = it }, "Search chats")

        if (loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Column
        }
        if (loadError != null && users.isEmpty() && groups.isEmpty()) {
            EmptyState(
                icon = Icons.Default.CloudOff,
                title = "Couldn't load chats",
                subtitle = loadError,
                actionLabel = "Try again",
                onAction = { scope.launch { loading = true; refresh(); loading = false } },
            )
            return@Column
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; refresh(); refreshing = false } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
                if (q.isBlank() && online.isNotEmpty() && !showArchived) {
                    item { SectionHeader("Online now") }
                    item {
                        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            items(online, key = { it.id }) { u ->
                                Column(
                                    Modifier.width(62.dp).clip(MaterialTheme.shapes.medium).clickable { onOpenDm(u.id) }.padding(vertical = 4.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally,
                                ) {
                                    Avatar(u.display_name, u.avatar_file_id, size = 54, status = presence[u.id] ?: u.status)
                                    Spacer(Modifier.height(6.dp))
                                    Text(u.display_name.substringBefore(' '), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                    item { SectionHeader("Messages") }
                }
                if (visible.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.AutoMirrored.Filled.Chat,
                            title = if (q.isBlank()) "No conversations yet" else "No chats match \"$q\"",
                            subtitle = if (q.isBlank()) "Message someone from People, or create a group" else null,
                            actionLabel = if (q.isBlank()) "Find people" else null,
                            onAction = if (q.isBlank()) onOpenPeople else null,
                        )
                    }
                }
                items(visible, key = { it.convo.key }) { item ->
                    val typingName = typing[item.convo.key]
                    ConversationRow(
                        item = item,
                        myId = me?.id,
                        typingName = typingName,
                        onClick = {
                            when (val c = item.convo) {
                                is Convo.Dm -> onOpenDm(c.peerId)
                                is Convo.GroupChat -> onOpenGroup(c.groupId)
                            }
                        },
                    )
                }
            }
        }
    }

    if (showChannels) {
        ChannelBrowserSheet(onDismiss = { showChannels = false }, onJoined = { gid -> onOpenGroup(gid) })
    }
    if (showNewGroup) {
        NewGroupSheet(
            users = users.filter { it.id != me?.id && !it.disabled },
            onDismiss = { showNewGroup = false },
            onCreated = { gid ->
                showNewGroup = false
                scope.launch { ChatRepository.loadGroups() }
                onOpenGroup(gid)
            },
        )
    }
}

@Composable
private fun ConversationRow(item: ConvoItem, myId: Long?, typingName: String?, onClick: () -> Unit) {
    val hasUnread = item.unread > 0
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(item.title, item.avatarFileId, size = 54, status = item.status)
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (item.isGroup) {
                    Icon(if (item.isChannel) Icons.Default.Tag else Icons.Default.Groups, null, Modifier.size(16.dp).padding(end = 4.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    item.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (item.muted) Icon(Icons.Default.NotificationsOff, "Muted", Modifier.size(14.dp).padding(start = 4.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                Text(
                    shortTimestamp(item.last?.sent_at),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (hasUnread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = if (hasUnread) FontWeight.Bold else FontWeight.Normal,
                )
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                val last = item.last
                if (typingName == null && last != null && last.sender_id == myId && last.deleted_at == null) {
                    Icon(
                        if (last.read_at != null) Icons.Default.DoneAll else Icons.Default.Done, null,
                        Modifier.size(16.dp).padding(end = 3.dp),
                        tint = if (last.read_at != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (typingName == null) previewIcon(last)?.let { icon ->
                    Icon(icon, null, Modifier.size(16.dp).padding(end = 3.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    when {
                        typingName != null -> if (item.isGroup) "$typingName ${if (typingName.contains(", ")) "are" else "is"} typing…" else "typing…"
                        last == null -> if (item.isGroup) "No messages yet — say hi" else ""
                        else -> previewText(last, myId, item.isGroup)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = when {
                        typingName != null -> MaterialTheme.colorScheme.primary
                        hasUnread -> MaterialTheme.colorScheme.onSurface
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    fontWeight = if (hasUnread) FontWeight.Medium else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                UnreadBadge(item.unread, Modifier.padding(start = 8.dp))
            }
        }
    }
}

@Composable
private fun NewGroupSheet(users: List<User>, onDismiss: () -> Unit, onCreated: (Long) -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var filter by remember { mutableStateOf("") }
    val selected = remember { mutableStateListOf<Long>() }
    var busy by remember { mutableStateOf(false) }
    var isPublic by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.fillMaxHeight(0.85f).padding(bottom = 16.dp)) {
            Text("New group", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp))
            OutlinedTextField(
                name, { name = it.take(64) }, label = { Text("Group name") }, singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), shape = MaterialTheme.shapes.medium,
            )
            SearchField(filter, { filter = it }, "Add people")
            Text(
                if (selected.isEmpty()) "Pick at least one person" else "${selected.size} selected",
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
            )
            LazyColumn(Modifier.weight(1f)) {
                items(users.filter { filter.isBlank() || it.display_name.contains(filter, true) || it.username.contains(filter, true) }, key = { it.id }) { u ->
                    val checked = u.id in selected
                    Row(
                        Modifier.fillMaxWidth().clickable { if (checked) selected.remove(u.id) else selected.add(u.id) }.padding(horizontal = 20.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Avatar(u.display_name, u.avatar_file_id, size = 40)
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            Text(u.display_name, style = MaterialTheme.typography.bodyLarge)
                            Text("@${u.username}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Checkbox(checked = checked, onCheckedChange = { if (it) selected.add(u.id) else selected.remove(u.id) })
                    }
                }
            }
            Row(Modifier.fillMaxWidth().clickable { isPublic = !isPublic }.padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Public channel", style = MaterialTheme.typography.bodyLarge)
                    Text("Anyone on this server can find and join it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(isPublic, { isPublic = it })
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp)) }
            PrimaryButton(
                "Create group",
                enabled = name.isNotBlank() && selected.isNotEmpty(),
                busy = busy,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        runCatching { SessionManager.api.createGroup(name.trim(), selected.toList(), isPublic) }
                            .onSuccess { onCreated(it.id) }
                            .onFailure { error = it.message ?: "Couldn't create the group" }
                        busy = false
                    }
                },
            )
        }
    }
}
