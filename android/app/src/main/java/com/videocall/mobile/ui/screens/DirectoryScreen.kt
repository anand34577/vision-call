package com.videocall.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.call.CallRepository
import com.videocall.mobile.net.User
import com.videocall.mobile.net.UserBrief
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.EmptyState
import com.videocall.mobile.ui.components.ScreenHeader
import com.videocall.mobile.ui.components.SearchField
import com.videocall.mobile.ui.components.SectionHeader
import com.videocall.mobile.ui.components.presenceColor
import com.videocall.mobile.ui.components.presenceLabel
import com.videocall.mobile.ui.util.rememberCallLauncher

@Composable
fun DirectoryScreen(onOpenDm: (Long) -> Unit, contentPadding: PaddingValues = PaddingValues()) {
    val scope = rememberCoroutineScope()
    var users by remember { mutableStateOf<List<User>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val presence by SessionManager.presence.collectAsState()
    val me by SessionManager.me.collectAsState()

    suspend fun refresh() {
        runCatching { SessionManager.api.users() }
            .onSuccess { users = it; loadError = null }
            .onFailure { loadError = it.message ?: "Couldn't load people" }
    }

    LaunchedEffect(Unit) {
        refresh()
        loading = false
    }

    val q = query.trim()
    val visible = users.filter { it.id != me?.id && !it.disabled }
        .filter { q.isBlank() || it.display_name.contains(q, true) || it.username.contains(q, true) }
    fun statusOf(u: User) = presence[u.id] ?: u.status
    val onlineNow = visible.filter { statusOf(it) != "offline" }.sortedBy { it.display_name.lowercase() }
    val offline = visible.filter { statusOf(it) == "offline" }.sortedBy { it.display_name.lowercase() }

    Column(Modifier.fillMaxSize().padding(bottom = contentPadding.calculateBottomPadding())) {
        ScreenHeader("People", subtitle = if (!loading) "${onlineNow.size} online · ${visible.size} total" else null)
        SearchField(query, { query = it }, "Search by name or username")
        if (loading) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Column
        }
        if (loadError != null && users.isEmpty()) {
            EmptyState(
                icon = Icons.Default.CloudOff,
                title = "Couldn't load people",
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
                if (visible.isEmpty()) {
                    item {
                        EmptyState(
                            icon = Icons.Default.People,
                            title = if (q.isBlank()) "No one else here yet" else "No one matches \"$q\"",
                            subtitle = if (q.isBlank()) "Your administrator adds accounts for your team" else "Try a different name or username",
                        )
                    }
                }
                if (onlineNow.isNotEmpty()) {
                    item { SectionHeader("Online — ${onlineNow.size}") }
                    items(onlineNow, key = { it.id }) { u -> PersonRow(u, statusOf(u), onOpenDm) }
                }
                if (offline.isNotEmpty()) {
                    item { SectionHeader("Offline — ${offline.size}") }
                    items(offline, key = { it.id }) { u -> PersonRow(u, statusOf(u), onOpenDm) }
                }
            }
        }
    }
}

@Composable
private fun PersonRow(user: User, status: String, onOpenDm: (Long) -> Unit) {
    val context = LocalContext.current
    val brief = UserBrief(user.id, user.display_name, user.username, user.avatar_file_id)
    val launchCall = rememberCallLauncher(
        onDenied = { android.widget.Toast.makeText(context, "Microphone/camera permission is needed to call", android.widget.Toast.LENGTH_SHORT).show() },
        onStart = { video -> CallRepository.startDmCall(context, brief, video) },
    )
    Row(
        Modifier.fillMaxWidth().clickable { onOpenDm(user.id) }.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(user.display_name, user.avatar_file_id, size = 48, status = status)
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(user.display_name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (user.role == "admin") {
                    Text(
                        "Admin", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = 6.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).clip(MaterialTheme.shapes.extraLarge).background(presenceColor(status)))
                Text(
                    " ${presenceLabel(status)} · @${user.username}" + (if (user.status_text.isNotBlank()) " · ${user.status_text}" else ""), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        FilledTonalIconButton(onClick = { launchCall(false) }) { Icon(Icons.Default.Call, "Voice call", Modifier.size(20.dp)) }
        FilledTonalIconButton(onClick = { launchCall(true) }) { Icon(Icons.Default.Videocam, "Video call", Modifier.size(20.dp)) }
    }
}
