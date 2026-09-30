package com.videocall.mobile.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.videocall.mobile.net.Prefs
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.PrimaryButton

/**
 * Two steps in one screen: pick which server to talk to (this app can point
 * at any self-hosted instance), then sign in to it. The server step is
 * skipped once one is saved.
 */
@Composable
fun LoginScreen(onLoggedIn: () -> Unit, onOidcLogin: () -> Unit = {}, onForgotPassword: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var serverInput by remember { mutableStateOf(Prefs.serverUrl(context) ?: "") }
    var hasServer by remember { mutableStateOf(SessionManager.hasServer) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var needTotp by remember { mutableStateOf(false) }
    var showPassword by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(SessionManager.consumeLogoutReason()) }
    var oidcLabel by remember { mutableStateOf<String?>(null) }
    var resetEnabled by remember { mutableStateOf(false) }

    LaunchedEffect(hasServer) {
        if (!hasServer) return@LaunchedEffect
        oidcLabel = runCatching { SessionManager.api.oidcConfig() }.getOrNull()?.takeIf { it.enabled }?.let { it.button_label ?: "Single sign-on" }
        resetEnabled = runCatching { SessionManager.api.passwordResetEnabled()["enabled"] }.getOrNull() == true
    }

    fun signIn() {
        if (loading || username.isBlank() || password.isBlank()) return
        focus.clearFocus()
        loading = true
        error = null
        scope.launch {
            val result = SessionManager.login(username.trim(), password, if (needTotp) totp.trim() else null)
            loading = false
            result.onSuccess { onLoggedIn() }.onFailure {
                if (it.message == "two-factor code required") needTotp = true
                else { error = friendlyError(it); if (needTotp) totp = "" }
            }
        }
    }

    fun connect() {
        if (serverInput.isBlank() || loading) return
        focus.clearFocus()
        loading = true
        error = null
        scope.launch {
            Prefs.setServerUrl(context, serverInput)
            val url = Prefs.serverUrl(context)!!
            SessionManager.bind(url)
            // Check it's really a Vision Call server before moving on.
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    SessionManager.api.client.newCall(okhttp3.Request.Builder().url("$url/api/healthz").build()).execute().use { it.isSuccessful }
                }.getOrElse { e -> error = friendlyError(e); false }
            }
            loading = false
            if (ok) hasServer = true else if (error == null) error = "That address didn't answer like a Vision Call server"
        }
    }

    val accent = MaterialTheme.colorScheme.primary
    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(listOf(accent.copy(alpha = 0.28f), MaterialTheme.colorScheme.background, MaterialTheme.colorScheme.background)),
        ),
    ) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).systemBarsPadding().imePadding().padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Box(
                Modifier.size(76.dp).clip(RoundedCornerShape(24.dp))
                    .background(Brush.linearGradient(listOf(accent, Color(0xFF8B5CF6)))),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Default.Videocam, null, tint = Color.White, modifier = Modifier.size(40.dp)) }
            Spacer(Modifier.height(18.dp))
            Text("Vision Call", style = MaterialTheme.typography.headlineLarge)
            Text(
                "Calls and chat on your own server",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(32.dp))

            Surface(shape = MaterialTheme.shapes.extraLarge, color = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 0.dp, modifier = Modifier.fillMaxWidth()) {
                AnimatedContent(targetState = hasServer, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "login-step") { serverChosen ->
                    Column(Modifier.padding(22.dp)) {
                        if (!serverChosen) {
                            Text("Connect to your server", style = MaterialTheme.typography.titleLarge)
                            Text(
                                "Ask your admin for the address of your Vision Call server.",
                                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(18.dp))
                            OutlinedTextField(
                                value = serverInput,
                                onValueChange = { serverInput = it; error = null },
                                label = { Text("Server address") },
                                placeholder = { Text("https://192.168.1.50:8443") },
                                leadingIcon = { Icon(Icons.Default.Dns, null) },
                                singleLine = true,
                                shape = MaterialTheme.shapes.medium,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                                keyboardActions = KeyboardActions(onGo = { connect() }),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            ErrorText(error)
                            Spacer(Modifier.height(16.dp))
                            PrimaryButton("Continue", enabled = serverInput.isNotBlank(), busy = loading, onClick = { connect() })
                            Text(
                                "Uses a self-signed certificate? Install its CA on this phone first (Settings › Security › Encryption & credentials › Install a certificate).",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 14.dp),
                            )
                        } else {
                            Text("Welcome back", style = MaterialTheme.typography.titleLarge)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Default.Dns, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(
                                    " " + (Prefs.serverUrl(context) ?: "").removePrefix("https://").removePrefix("http://"),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = {
                                    Prefs.clearServer(context)
                                    hasServer = false
                                    error = null
                                }) { Text("Change") }
                            }
                            Spacer(Modifier.height(10.dp))
                            OutlinedTextField(
                                value = username, onValueChange = { username = it; error = null },
                                label = { Text("Username") }, singleLine = true,
                                leadingIcon = { Icon(Icons.Default.Person, null) },
                                shape = MaterialTheme.shapes.medium,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Spacer(Modifier.height(12.dp))
                            OutlinedTextField(
                                value = password, onValueChange = { password = it; error = null },
                                label = { Text("Password") }, singleLine = true,
                                leadingIcon = { Icon(Icons.Default.Lock, null) },
                                trailingIcon = {
                                    IconButton(onClick = { showPassword = !showPassword }) {
                                        Icon(if (showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility, if (showPassword) "Hide password" else "Show password")
                                    }
                                },
                                visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                                shape = MaterialTheme.shapes.medium,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { signIn() }),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            if (needTotp) {
                                Spacer(Modifier.height(12.dp))
                                OutlinedTextField(
                                    value = totp, onValueChange = { totp = it.filter(Char::isDigit).take(6); error = null },
                                    label = { Text("Authenticator code") }, singleLine = true,
                                    leadingIcon = { Icon(Icons.Default.Shield, null) },
                                    shape = MaterialTheme.shapes.medium,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                                    keyboardActions = KeyboardActions(onDone = { signIn() }),
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                            ErrorText(error)
                            if (resetEnabled) {
                                TextButton(onClick = onForgotPassword, modifier = Modifier.align(Alignment.End)) { Text("Forgot password?") }
                            } else Spacer(Modifier.height(16.dp))
                            PrimaryButton("Sign in", enabled = username.isNotBlank() && password.isNotBlank() && (!needTotp || totp.length == 6), busy = loading, onClick = { signIn() })
                            oidcLabel?.let { label ->
                                Row(Modifier.padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                                    HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                                    Text("  or  ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
                                }
                                OutlinedButton(onClick = onOidcLogin, modifier = Modifier.fillMaxWidth().height(52.dp), shape = MaterialTheme.shapes.medium) {
                                    Icon(Icons.Default.Key, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(label)
                                }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.VerifiedUser, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    " Accounts are created by your administrator",
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun ErrorText(error: String?) {
    if (error == null) return
    Row(
        Modifier.fillMaxWidth().padding(top = 12.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.errorContainer).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.ErrorOutline, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onErrorContainer)
        Text(" $error", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer)
    }
}

private fun friendlyError(e: Throwable): String = when (e) {
    is java.net.UnknownHostException -> "Can't find that server — check the address"
    is java.net.ConnectException, is java.net.SocketTimeoutException -> "Can't reach the server — are you on the right network or VPN?"
    is javax.net.ssl.SSLHandshakeException -> "The server's certificate isn't trusted on this phone — install its CA certificate first"
    is javax.net.ssl.SSLException -> "Secure connection failed: ${e.message ?: "TLS error"}"
    is com.videocall.mobile.net.ApiException -> e.message ?: "Sign-in failed"
    else -> e.message ?: "Something went wrong"
}
