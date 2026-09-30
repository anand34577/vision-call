package com.videocall.mobile.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.DeleteForever
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Restore
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.net.AdminStats
import com.videocall.mobile.net.AuditEntry
import com.videocall.mobile.net.SettingView
import com.videocall.mobile.net.User
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.AppListRow
import com.videocall.mobile.ui.components.ConfirmDialog
import com.videocall.mobile.ui.components.EmptyState
import com.videocall.mobile.ui.components.SectionCard

private enum class AdminTab { USERS, GROUPS, SETTINGS, AUDIT }

/** Full admin console: server stats + user CRUD, live settings editor, audit log. */
@Composable
fun AdminScreen(onBack: () -> Unit) {
    var tab by remember { mutableStateOf(AdminTab.USERS) }
    val snackbarHostState = remember { SnackbarHostState() }
    val snackScope = rememberCoroutineScope()
    val showError: (String) -> Unit = { msg -> snackScope.launch { snackbarHostState.showSnackbar(msg) } }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") } },
                    title = { Text("Admin") },
                )
                TabRow(selectedTabIndex = tab.ordinal) {
                    Tab(selected = tab == AdminTab.USERS, onClick = { tab = AdminTab.USERS }, text = { Text("Users") })
                    Tab(selected = tab == AdminTab.GROUPS, onClick = { tab = AdminTab.GROUPS }, text = { Text("Groups") })
                    Tab(selected = tab == AdminTab.SETTINGS, onClick = { tab = AdminTab.SETTINGS }, text = { Text("Settings") })
                    Tab(selected = tab == AdminTab.AUDIT, onClick = { tab = AdminTab.AUDIT }, text = { Text("Audit log") })
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                AdminTab.USERS -> AdminUsersTab(showError)
                AdminTab.GROUPS -> AdminGroupsTab(showError)
                AdminTab.SETTINGS -> AdminSettingsTab(showError)
                AdminTab.AUDIT -> AdminAuditTab()
            }
        }
    }
}

private enum class UserFilter(val label: String) { ALL("All"), ADMINS("Admins"), SUSPENDED("Suspended"), DELETED("Deleted") }

private fun UserFilter.matches(u: User): Boolean = when (this) {
    UserFilter.ALL -> !u.deleted
    UserFilter.ADMINS -> !u.deleted && u.role == "admin"
    UserFilter.SUSPENDED -> !u.deleted && u.disabled
    UserFilter.DELETED -> u.deleted
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminUsersTab(showMessage: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val me by SessionManager.me.collectAsState()
    var stats by remember { mutableStateOf<AdminStats?>(null) }
    var users by remember { mutableStateOf<List<User>>(emptyList()) }
    var filter by remember { mutableStateOf(UserFilter.ALL) }
    var showCreate by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var editTarget by remember { mutableStateOf<User?>(null) }
    var suspendTarget by remember { mutableStateOf<User?>(null) }
    var deleteTarget by remember { mutableStateOf<User?>(null) }

    suspend fun refresh() {
        stats = runCatching { SessionManager.api.adminStats() }.getOrNull()
        users = runCatching { SessionManager.api.users() }.getOrDefault(emptyList())
    }

    // Runs an admin action, then reports the outcome and reloads the list.
    fun act(success: String, block: suspend () -> Unit) {
        scope.launch {
            runCatching { block() }
                .onSuccess { showMessage(success) }
                .onFailure { showMessage(it.message ?: "Something went wrong") }
            refresh()
        }
    }

    LaunchedEffect(Unit) { refresh(); loading = false }

    if (loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    val visible = users.filter { filter.matches(it) }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 16.dp, bottom = 88.dp)) {
            item {
                stats?.let { s ->
                    SectionCard {
                        Column(Modifier.padding(16.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                StatTile("Accounts", "${s.users}")
                                StatTile("Online", "${s.online}")
                                StatTile("Active calls", "${s.active_calls}")
                            }
                            Spacer(Modifier.height(12.dp))
                            HorizontalDivider()
                            Spacer(Modifier.height(8.dp))
                            Text("Version ${s.version}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("DB: ${s.db_driver}  ·  Storage: ${s.storage.total_bytes / 1_000_000} MB", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                }
                FlowRow(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    UserFilter.entries.forEach { f ->
                        val count = users.count { f.matches(it) }
                        FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text("${f.label} $count") })
                    }
                }
            }
            if (visible.isEmpty()) {
                item { Text("Nobody here.", Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            items(visible, key = { it.id }) { user ->
                val isMe = user.id == me?.id
                var menu by remember { mutableStateOf(false) }
                val status = when {
                    user.deleted -> "deleted"
                    user.disabled -> "suspended"
                    else -> user.role
                }
                AppListRow(
                    modifier = Modifier.animateItem(),
                    leading = { Avatar(user.display_name, user.avatar_file_id) },
                    title = user.display_name + if (isMe) " (you)" else "",
                    subtitle = "@${user.username} · $status",
                    subtitleColor = when {
                        user.deleted -> MaterialTheme.colorScheme.onSurfaceVariant
                        user.disabled -> MaterialTheme.colorScheme.error
                        else -> Color.Unspecified
                    },
                    onClick = if (user.deleted) null else ({ editTarget = user }),
                    trailing = {
                        if (user.deleted) {
                            IconButton(onClick = { deleteTarget = user }) {
                                Icon(Icons.Default.DeleteForever, "Erase permanently", tint = MaterialTheme.colorScheme.error)
                            }
                        } else if (!isMe) {
                            Box {
                                IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "Actions") }
                                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                    DropdownMenuItem(
                                        text = { Text("Edit") },
                                        leadingIcon = { Icon(Icons.Default.Edit, null) },
                                        onClick = { menu = false; editTarget = user },
                                    )
                                    DropdownMenuItem(
                                        text = { Text(if (user.disabled) "Reactivate" else "Suspend") },
                                        leadingIcon = { Icon(if (user.disabled) Icons.Default.HowToReg else Icons.Default.Block, null) },
                                        onClick = { menu = false; suspendTarget = user },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Sign out everywhere") },
                                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.Logout, null) },
                                        onClick = {
                                            menu = false
                                            act("${user.display_name} was signed out of every device.") { SessionManager.api.signOutUser(user.id) }
                                        },
                                    )
                                    DropdownMenuItem(
                                        text = { Text("Delete…", color = MaterialTheme.colorScheme.error) },
                                        leadingIcon = { Icon(Icons.Default.Delete, null, tint = MaterialTheme.colorScheme.error) },
                                        onClick = { menu = false; deleteTarget = user },
                                    )
                                }
                            }
                        }
                    },
                )
            }
        }
        FloatingActionButton(onClick = { showCreate = true }, modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
            Icon(Icons.Default.PersonAdd, "Add user")
        }
    }

    if (showCreate) {
        CreateUserDialog(
            onDismiss = { showCreate = false },
            onCreate = { username, displayName, password, role ->
                showCreate = false
                act("Created $displayName.") { SessionManager.api.createUser(username, displayName, password, role) }
            },
        )
    }
    editTarget?.let { user ->
        EditUserDialog(
            user = user,
            isMe = user.id == me?.id,
            onDismiss = { editTarget = null },
            onSave = { name, role, email, password ->
                editTarget = null
                val msg = if (password != null) "Saved. ${user.display_name} must sign in with the new password." else "Saved changes to $name."
                act(msg) {
                    SessionManager.api.updateUser(
                        user.id,
                        displayName = name,
                        role = role.takeIf { it != user.role },
                        email = email,
                        password = password,
                    )
                }
            },
        )
    }
    suspendTarget?.let { user ->
        ConfirmDialog(
            title = if (user.disabled) "Reactivate ${user.display_name}?" else "Suspend ${user.display_name}?",
            message = if (user.disabled) "They'll be able to sign in again."
            else "They're signed out right away and can't sign in until you reactivate them. Nothing is deleted.",
            confirmLabel = if (user.disabled) "Reactivate" else "Suspend",
            destructive = !user.disabled,
            onConfirm = {
                val msg = if (user.disabled) "${user.display_name} can sign in again." else "${user.display_name} is suspended."
                act(msg) { SessionManager.api.updateUser(user.id, disabled = !user.disabled) }
            },
            onDismiss = { suspendTarget = null },
        )
    }
    deleteTarget?.let { user ->
        DeleteUserDialog(
            user = user,
            onDismiss = { deleteTarget = null },
            onDelete = { erase ->
                deleteTarget = null
                val msg = if (erase) "${user.display_name} and all their data were erased." else "${user.display_name} was removed."
                act(msg) { SessionManager.api.deleteUser(user.id, permanent = erase) }
            },
        )
    }
}

@Composable
private fun EditUserDialog(user: User, isMe: Boolean, onDismiss: () -> Unit, onSave: (String, String, String, String?) -> Unit) {
    var name by remember { mutableStateOf(user.display_name) }
    var email by remember { mutableStateOf(user.email ?: "") }
    var isAdmin by remember { mutableStateOf(user.role == "admin") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit ${user.display_name}") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(name, { name = it }, label = { Text("Display name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(email, { email = it }, label = { Text("Email (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    password, { password = it },
                    label = { Text("New password") },
                    placeholder = { Text("Leave empty to keep it") },
                    singleLine = true,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(if (showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility, if (showPassword) "Hide password" else "Show password")
                        }
                    },
                    supportingText = { if (password.isNotEmpty() && password.length < 8) Text("At least 8 characters") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = isAdmin, onCheckedChange = { isAdmin = it }, enabled = !isMe)
                    Text(if (isMe) "Admin (you can't change your own role)" else "Admin")
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && (password.isEmpty() || password.length >= 8),
                onClick = { onSave(name.trim(), if (isAdmin) "admin" else "user", email.trim(), password.ifEmpty { null }) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DeleteUserDialog(user: User, onDismiss: () -> Unit, onDelete: (erase: Boolean) -> Unit) {
    var erase by remember { mutableStateOf(user.deleted) }
    var confirm by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (user.deleted) "Erase @${user.username}?" else "Delete ${user.display_name}?") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (!user.deleted) {
                    DeleteOption(
                        selected = !erase,
                        title = "Remove account",
                        text = "They can never sign in again. Their messages stay in other people's chats as \"Deleted user\".",
                        onClick = { erase = false },
                    )
                    Spacer(Modifier.height(8.dp))
                    DeleteOption(
                        selected = erase,
                        title = "Erase everything",
                        text = "Permanently deletes the account with all their messages, chats, calls, files and rooms.",
                        onClick = { erase = true },
                    )
                }
                if (erase) {
                    Spacer(Modifier.height(12.dp))
                    Text("This can't be undone. Type ${user.username} to confirm.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(4.dp))
                    OutlinedTextField(confirm, { confirm = it }, singleLine = true, placeholder = { Text(user.username) }, modifier = Modifier.fillMaxWidth())
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !erase || confirm.trim() == user.username,
                onClick = { onDelete(erase) },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) { Text(if (erase) "Erase permanently" else "Remove account") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DeleteOption(selected: Boolean, title: String, text: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f) else Color.Transparent,
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            RadioButton(selected = selected, onClick = onClick)
            Column(Modifier.padding(start = 4.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun AdminSettingsTab(showError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var settings by remember { mutableStateOf<List<SettingView>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var editing by remember { mutableStateOf<SettingView?>(null) }

    suspend fun refresh() {
        settings = runCatching { SessionManager.api.listSettings() }.getOrDefault(emptyList())
    }
    LaunchedEffect(Unit) { refresh(); loading = false }

    if (loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        settings.groupBy { it.group }.forEach { (group, items) ->
            item { Text(group, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(16.dp, 12.dp, 16.dp, 4.dp), color = MaterialTheme.colorScheme.primary) }
            items(items) { s ->
                ListItem(
                    modifier = if (s.editable) Modifier.clickableRow { editing = s } else Modifier,
                    headlineContent = { Text(s.label) },
                    supportingContent = {
                        Column {
                            Text(s.description, style = MaterialTheme.typography.bodySmall)
                            Text(if (s.kind == "secret" && s.value.isNotBlank()) "••••••••" else s.value.ifBlank { "(default)" }, style = MaterialTheme.typography.labelSmall)
                        }
                    },
                    trailingContent = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (!s.editable) Icon(Icons.Default.Lock, "Locked by environment", modifier = Modifier.size(16.dp))
                            if (s.editable && s.source == "db") {
                                IconButton(onClick = { scope.launch {
                                    runCatching { SessionManager.api.resetSetting(s.key) }
                                        .onFailure { showError(it.message ?: "Failed to reset setting") }
                                    refresh()
                                } }) {
                                    Icon(Icons.Default.Restore, "Reset to default")
                                }
                            }
                        }
                    },
                )
                Divider()
            }
        }
    }
    editing?.let { s ->
        var value by remember(s.key) { mutableStateOf(if (s.kind == "secret") "" else s.value) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(s.label) },
            text = {
                Column {
                    Text(s.description, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                    if (s.kind == "bool") {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = value == "true", onCheckedChange = { value = if (it) "true" else "false" })
                            Text("Enabled")
                        }
                    } else {
                        OutlinedTextField(value, { value = it }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (s.kind == "secret" && value.isBlank()) { editing = null; return@TextButton }
                    scope.launch {
                        runCatching { SessionManager.api.updateSetting(s.key, value) }
                            .onFailure { showError(it.message ?: "Failed to save setting") }
                        refresh()
                    }
                    editing = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun AdminAuditTab() {
    var entries by remember { mutableStateOf<List<AuditEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        entries = runCatching { SessionManager.api.auditLog() }.getOrDefault(emptyList())
        loading = false
    }
    if (loading) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    if (entries.isEmpty()) {
        EmptyState(icon = Icons.Default.History, title = "No audit entries yet", subtitle = "Admin actions will be logged here")
        return
    }
    LazyColumn(Modifier.fillMaxSize()) {
        items(entries) { e ->
            AppListRow(
                leading = {},
                title = "${e.actor_name} · ${e.action}",
                subtitle = e.detail.ifBlank { "${e.target_type} #${e.target_id ?: ""}" } + "  ·  ${e.ip}",
                trailing = { Text(e.created_at.take(16).replace("T", " "), style = MaterialTheme.typography.labelSmall) },
            )
            Divider()
        }
    }
}

private fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.then(Modifier.clickable(onClick = onClick))

@Composable
private fun StatTile(label: String, value: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(value, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun CreateUserDialog(onDismiss: () -> Unit, onCreate: (String, String, String, String) -> Unit) {
    var username by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var isAdmin by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New user") },
        text = {
            Column {
                OutlinedTextField(username, { username = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(displayName, { displayName = it }, label = { Text("Display name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    password, { password = it },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    supportingText = { if (password.isNotEmpty() && password.length < 8) Text("At least 8 characters") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = isAdmin, onCheckedChange = { isAdmin = it })
                    Text("Admin")
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = username.isNotBlank() && displayName.isNotBlank() && password.length >= 8,
                onClick = { onCreate(username.trim(), displayName.trim(), password, if (isAdmin) "admin" else "user") },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
