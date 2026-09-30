package com.videocall.mobile.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.chat.ChatRepository
import com.videocall.mobile.net.Group
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.ConfirmDialog
import com.videocall.mobile.ui.components.EmptyState

/** Admin overview of every group and channel on the server, with delete. */
@Composable
fun AdminGroupsTab(showError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var groups by remember { mutableStateOf<List<Group>?>(null) }
    var deleteTarget by remember { mutableStateOf<Group?>(null) }

    suspend fun refresh() {
        runCatching { SessionManager.api.adminGroups() }
            .onSuccess { groups = it }
            .onFailure { showError(it.message ?: "Couldn't load groups"); if (groups == null) groups = emptyList() }
    }
    LaunchedEffect(Unit) { refresh() }

    val list = groups
    if (list == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    if (list.isEmpty()) {
        EmptyState(icon = Icons.Default.Groups, title = "No groups yet", subtitle = "Groups and channels people create will show up here")
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(list, key = { it.id }) { g ->
            ListItem(
                leadingContent = { Avatar(g.name, g.avatar_file_id, size = 44) },
                headlineContent = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (g.public) { Icon(Icons.Default.Tag, "Public channel", Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)) }
                        Text(g.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                supportingContent = {
                    Text(
                        "${g.member_count} members · created ${g.created_at.take(10)}" + if (g.topic.isNotBlank()) " · ${g.topic}" else "",
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                },
                trailingContent = {
                    IconButton(onClick = { deleteTarget = g }) { Icon(Icons.Default.DeleteOutline, "Delete ${g.name}", tint = MaterialTheme.colorScheme.error) }
                },
            )
            HorizontalDivider()
        }
    }
    deleteTarget?.let { g ->
        ConfirmDialog(
            title = "Delete \"${g.name}\"?",
            message = "This permanently deletes the group and all of its messages for everyone. This can't be undone.",
            confirmLabel = "Delete",
            onConfirm = {
                scope.launch {
                    runCatching { SessionManager.api.deleteGroup(g.id) }.onFailure { showError(it.message ?: "Couldn't delete the group") }
                    refresh()
                    ChatRepository.loadGroups()
                }
            },
            onDismiss = { deleteTarget = null },
        )
    }
}
