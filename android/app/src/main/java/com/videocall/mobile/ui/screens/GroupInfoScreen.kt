package com.videocall.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.chat.ChatRepository
import com.videocall.mobile.net.Group
import com.videocall.mobile.net.GroupMember
import com.videocall.mobile.net.User
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.AppListRow
import com.videocall.mobile.ui.components.ConfirmDialog

@Composable
fun GroupInfoScreen(groupId: Long, onBack: () -> Unit, onLeft: () -> Unit) {
    val scope = rememberCoroutineScope()
    val me by SessionManager.me.collectAsState()
    var group by remember { mutableStateOf<Group?>(null) }
    var loading by remember { mutableStateOf(true) }
    var renaming by remember { mutableStateOf(false) }
    var showAddMembers by remember { mutableStateOf(false) }
    var allUsers by remember { mutableStateOf<List<User>>(emptyList()) }
    val snackbarHostState = remember { SnackbarHostState() }
    val showError: (String) -> Unit = { msg -> scope.launch { snackbarHostState.showSnackbar(msg) } }
    var removeTarget by remember { mutableStateOf<GroupMember?>(null) }
    var confirmLeave by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    suspend fun refresh() {
        ChatRepository.loadGroups()
        group = ChatRepository.groups.value.firstOrNull { it.id == groupId }
    }

    LaunchedEffect(groupId) {
        refresh()
        allUsers = runCatching { SessionManager.api.users() }.getOrDefault(emptyList())
        loading = false
    }

    val myRole = group?.members?.firstOrNull { it.id == me?.id }?.role
    val amOwnerOrAdmin = myRole == "owner" || myRole == "admin"

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") } },
                title = { Text("Group info") },
                actions = { if (amOwnerOrAdmin) IconButton(onClick = { renaming = true }) { Icon(Icons.Default.Edit, "Rename") } },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        if (loading || group == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        val g = group!!
        Column(Modifier.padding(padding).fillMaxSize()) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(g.name, g.avatar_file_id, size = 56)
                Spacer(Modifier.width(16.dp))
                Column {
                    Text(g.name, style = MaterialTheme.typography.titleLarge)
                    Text("${g.members.size} members", style = MaterialTheme.typography.bodyMedium)
                    if (g.topic.isNotBlank()) Text(g.topic, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Divider()
            if (amOwnerOrAdmin) {
                Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Public channel", style = MaterialTheme.typography.bodyLarge)
                        Text("Anyone on this server can find and join", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(g.public, { on ->
                        scope.launch {
                            runCatching { SessionManager.api.setGroupPublic(groupId, on) }.onFailure { showError(it.message ?: "Couldn't change visibility") }
                            refresh()
                        }
                    })
                }
                Divider()
            }
            Row(Modifier.fillMaxWidth().padding(16.dp, 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Members", style = MaterialTheme.typography.titleMedium)
                if (amOwnerOrAdmin) TextButton(onClick = { showAddMembers = true }) { Text("Add") }
            }
            LazyColumn(Modifier.weight(1f)) {
                items(g.members) { m ->
                    AppListRow(
                        leading = { Avatar(m.display_name, m.avatar_file_id) },
                        title = m.display_name + if (m.id == me?.id) " (you)" else "",
                        subtitle = m.role,
                        trailing = {
                            if (amOwnerOrAdmin && m.id != me?.id) {
                                var menu by remember { mutableStateOf(false) }
                                Box {
                                    IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Actions") }
                                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                        if (m.role != "admin") {
                                            DropdownMenuItem(text = { Text("Make admin") }, onClick = {
                                                scope.launch {
                                                    runCatching { SessionManager.api.setGroupMemberRole(groupId, m.id, "admin") }
                                                        .onFailure { showError(it.message ?: "Failed to change role") }
                                                    refresh()
                                                }
                                                menu = false
                                            })
                                        } else {
                                            DropdownMenuItem(text = { Text("Remove admin") }, onClick = {
                                                scope.launch {
                                                    runCatching { SessionManager.api.setGroupMemberRole(groupId, m.id, "member") }
                                                        .onFailure { showError(it.message ?: "Failed to change role") }
                                                    refresh()
                                                }
                                                menu = false
                                            })
                                        }
                                        DropdownMenuItem(text = { Text("Remove from group") }, onClick = {
                                            removeTarget = m
                                            menu = false
                                        })
                                    }
                                }
                            }
                        },
                    )
                }
            }
            Divider()
            AppListRow(
                onClick = { confirmLeave = true },
                leading = { Icon(Icons.Default.ExitToApp, null, tint = MaterialTheme.colorScheme.error) },
                title = "Leave group",
                titleColor = MaterialTheme.colorScheme.error,
            )
            if (myRole == "owner") {
                AppListRow(
                    onClick = { confirmDelete = true },
                    leading = { Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error) },
                    title = "Delete group",
                    titleColor = MaterialTheme.colorScheme.error,
                )
            }
        }

        if (renaming) {
            var newName by remember { mutableStateOf(g.name) }
            var newTopic by remember { mutableStateOf(g.topic) }
            AlertDialog(
                onDismissRequest = { renaming = false },
                title = { Text("Edit group") },
                text = {
                    Column {
                        OutlinedTextField(newName, { newName = it.take(64) }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                        OutlinedTextField(newTopic, { newTopic = it.take(200) }, label = { Text("Topic") }, placeholder = { Text("What is this group for?") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        scope.launch {
                            runCatching { SessionManager.api.updateGroup(groupId, name = newName.trim(), topic = newTopic.trim()) }
                                .onFailure { showError(it.message ?: "Failed to rename group") }
                            refresh()
                        }
                        renaming = false
                    }) { Text("Save") }
                },
                dismissButton = { TextButton(onClick = { renaming = false }) { Text("Cancel") } },
            )
        }
        if (showAddMembers) {
            val candidates = allUsers.filter { u -> g.members.none { it.id == u.id } }
            val selected = remember { mutableStateListOf<Long>() }
            AlertDialog(
                onDismissRequest = { showAddMembers = false },
                title = { Text("Add members") },
                text = {
                    LazyColumn(Modifier.heightIn(max = 320.dp)) {
                        items(candidates) { u ->
                            val checked = selected.contains(u.id)
                            ListItem(
                                modifier = Modifier.clickable { if (checked) selected.remove(u.id) else selected.add(u.id) },
                                leadingContent = { Checkbox(checked = checked, onCheckedChange = { if (it) selected.add(u.id) else selected.remove(u.id) }) },
                                headlineContent = { Text(u.display_name) },
                            )
                        }
                    }
                },
                confirmButton = {
                    TextButton(enabled = selected.isNotEmpty(), onClick = {
                        scope.launch {
                            runCatching { SessionManager.api.addGroupMembers(groupId, selected.toList()) }
                                .onFailure { showError(it.message ?: "Failed to add members") }
                            refresh()
                        }
                        showAddMembers = false
                    }) { Text("Add") }
                },
                dismissButton = { TextButton(onClick = { showAddMembers = false }) { Text("Cancel") } },
            )
        }
        removeTarget?.let { m ->
            ConfirmDialog(
                title = "Remove ${m.display_name}?",
                message = "They'll be removed from this group and lose access to its messages.",
                confirmLabel = "Remove",
                onConfirm = {
                    scope.launch {
                        runCatching { SessionManager.api.removeGroupMember(groupId, m.id) }
                            .onFailure { showError(it.message ?: "Failed to remove member") }
                        refresh()
                    }
                },
                onDismiss = { removeTarget = null },
            )
        }
        if (confirmLeave) {
            ConfirmDialog(
                title = "Leave \"${g.name}\"?",
                message = "You'll no longer receive messages from this group unless someone adds you back.",
                confirmLabel = "Leave",
                onConfirm = {
                    scope.launch {
                        val me0 = me ?: return@launch
                        runCatching { SessionManager.api.removeGroupMember(groupId, me0.id) }
                            .onSuccess { onLeft() }
                            .onFailure { showError(it.message ?: "Failed to leave group") }
                    }
                },
                onDismiss = { confirmLeave = false },
            )
        }
        if (confirmDelete) {
            ConfirmDialog(
                title = "Delete \"${g.name}\"?",
                message = "This permanently deletes the group and its messages for every member. This can't be undone.",
                confirmLabel = "Delete",
                onConfirm = {
                    scope.launch {
                        runCatching { SessionManager.api.deleteGroup(groupId) }
                            .onSuccess { onLeft() }
                            .onFailure { showError(it.message ?: "Failed to delete group") }
                    }
                },
                onDismiss = { confirmDelete = false },
            )
        }
    }
}
