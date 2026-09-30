package com.videocall.mobile.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.net.SessionInfo
import com.videocall.mobile.net.TotpSetup
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.PrimaryButton

/** "In a meeting, back at 3…" — a short line shown next to your name. */
@Composable
fun StatusTextSheet(onDismiss: () -> Unit) {
    val me by SessionManager.me.collectAsState()
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf(me?.status_text ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).navigationBarsPadding().imePadding()) {
            Text("Status message", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                text, { text = it.take(140) }, singleLine = true, placeholder = { Text("What are you up to?") },
                supportingText = { Text("${text.length}/140") },
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            Spacer(Modifier.height(12.dp))
            PrimaryButton("Save", busy = busy, onClick = {
                busy = true
                error = null
                scope.launch {
                    runCatching { SessionManager.api.setStatusText(text.trim()) }
                        .onSuccess { r -> me?.let { SessionManager.setMe(it.copy(status_text = r["text"] ?: "")) }; onDismiss() }
                        .onFailure { error = it.message ?: "Couldn't save"; busy = false }
                }
            })
        }
    }
}

private fun deviceLabel(ua: String): String = when {
    ua.isBlank() -> "Unknown device"
    ua.contains("okhttp", true) -> "Android app"
    else -> {
        val browser = when {
            "Edg/" in ua -> "Edge"; "Firefox/" in ua -> "Firefox"; "Chrome/" in ua -> "Chrome"; "Safari/" in ua -> "Safari"; else -> "Browser"
        }
        val os = when {
            "Windows" in ua -> "Windows"; "Android" in ua -> "Android"; "iPhone" in ua || "iPad" in ua -> "iOS"; "Mac OS" in ua -> "macOS"; "Linux" in ua -> "Linux"; else -> ""
        }
        if (os.isEmpty()) browser else "$browser on $os"
    }
}

/** Every device signed in to this account, with remote sign-out. */
@Composable
fun DevicesSheet(onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<SessionInfo>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    fun load() { scope.launch { runCatching { SessionManager.api.sessions() }.onSuccess { list = it }.onFailure { error = it.message } } }
    LaunchedEffect(Unit) { load() }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(bottom = 28.dp).navigationBarsPadding()) {
            Text("Signed-in devices", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(20.dp)) }
            val l = list
            if (l == null && error == null) Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            if (l != null) {
                LazyColumn(Modifier.heightIn(max = 420.dp).padding(top = 8.dp)) {
                    items(l, key = { it.id }) { s ->
                        ListItem(
                            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                            leadingContent = { Icon(if (s.user_agent.contains("okhttp", true) || s.user_agent.contains("Android")) Icons.Default.Smartphone else Icons.Default.Laptop, null) },
                            headlineContent = { Text(deviceLabel(s.user_agent) + if (s.current) " · this device" else "") },
                            supportingContent = { Text("${s.ip.ifBlank { "unknown IP" }} · last active ${s.last_seen.ifBlank { s.created_at }.take(16).replace('T', ' ')} UTC") },
                            trailingContent = {
                                if (!s.current) TextButton(onClick = {
                                    scope.launch { runCatching { SessionManager.api.revokeSession(s.id) }.onSuccess { load() }.onFailure { error = it.message } }
                                }) { Text("Sign out") }
                            },
                        )
                    }
                }
                if (l.size > 1) {
                    TextButton(
                        onClick = { scope.launch { runCatching { SessionManager.api.revokeOtherSessions() }.onSuccess { load() }.onFailure { error = it.message } } },
                        modifier = Modifier.padding(horizontal = 12.dp),
                    ) { Text("Sign out all other devices") }
                }
            }
        }
    }
}

/** Set up or turn off authenticator-app two-step verification. */
@Composable
fun TwoFactorSheet(onDismiss: () -> Unit) {
    val me by SessionManager.me.collectAsState()
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var setup by remember { mutableStateOf<TotpSetup?>(null) }
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val enabled = me?.totp_enabled == true

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).navigationBarsPadding().imePadding()) {
            Text("Two-step verification", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(8.dp))
            val s = setup
            when {
                enabled -> {
                    Text("On. Sign-in asks for a 6-digit code from your authenticator app.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(
                        password, { password = it }, label = { Text("Your password") }, singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Spacer(Modifier.height(12.dp))
                    PrimaryButton("Turn off", enabled = password.isNotEmpty(), busy = busy, onClick = {
                        busy = true; error = null
                        scope.launch {
                            runCatching { SessionManager.api.totpDisable(password) }
                                .onSuccess { me?.let { SessionManager.setMe(it.copy(totp_enabled = false)) }; onDismiss() }
                                .onFailure { error = it.message ?: "Couldn't turn off"; busy = false }
                        }
                    })
                }
                s == null -> {
                    Text(
                        "Add a second step to sign-in. You'll need an authenticator app such as Google Authenticator, Aegis or 1Password.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Spacer(Modifier.height(12.dp))
                    PrimaryButton("Set up", busy = busy, onClick = {
                        busy = true; error = null
                        scope.launch {
                            runCatching { SessionManager.api.totpSetup() }
                                .onSuccess { setup = it }
                                .onFailure { error = it.message ?: "Couldn't start setup" }
                            busy = false
                        }
                    })
                }
                else -> {
                    Text("Add this key to your authenticator app as a time-based account, then enter the code it shows.", style = MaterialTheme.typography.bodyMedium)
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) {
                        Text(s.secret, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(14.dp))
                    }
                    Row {
                        TextButton(onClick = { clipboard.setText(AnnotatedString(s.secret)) }) { Text("Copy key") }
                        val ctx = androidx.compose.ui.platform.LocalContext.current
                        TextButton(onClick = {
                            runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(s.uri)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
                                .onFailure { error = "No authenticator app found — copy the key instead" }
                        }) { Text("Open in authenticator") }
                    }
                    OutlinedTextField(
                        code, { code = it.filter(Char::isDigit).take(6) }, label = { Text("6-digit code") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Spacer(Modifier.height(12.dp))
                    PrimaryButton("Turn on", enabled = code.length == 6, busy = busy, onClick = {
                        busy = true; error = null
                        scope.launch {
                            runCatching { SessionManager.api.totpEnable(s.secret, code) }
                                .onSuccess { me?.let { SessionManager.setMe(it.copy(totp_enabled = true)) }; onDismiss() }
                                .onFailure { error = it.message ?: "That code didn't work"; busy = false }
                        }
                    })
                }
            }
        }
    }
}
