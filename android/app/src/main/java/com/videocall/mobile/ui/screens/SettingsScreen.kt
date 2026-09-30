package com.videocall.mobile.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.io.File
import com.videocall.mobile.net.Prefs
import com.videocall.mobile.net.UserPreferences
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.Avatar
import com.videocall.mobile.ui.components.ConfirmDialog
import com.videocall.mobile.ui.components.PrimaryButton
import com.videocall.mobile.ui.components.ScreenHeader
import com.videocall.mobile.ui.components.SectionCard
import com.videocall.mobile.ui.components.SectionHeader
import com.videocall.mobile.ui.components.SettingsRow
import com.videocall.mobile.ui.components.presenceColor
import com.videocall.mobile.ui.theme.AccentPresets
import com.videocall.mobile.ui.theme.RadiusPresets
import com.videocall.mobile.ui.theme.ThemePresets
import com.videocall.mobile.ui.theme.ThemeState
import com.videocall.mobile.ui.theme.VcColor
import com.videocall.mobile.ui.util.isIgnoringBatteryOptimizations
import com.videocall.mobile.ui.util.requestIgnoreBatteryOptimizations
import com.videocall.mobile.ui.util.canUseFullScreenIntent
import com.videocall.mobile.ui.util.requestFullScreenIntent

@Composable
fun SettingsScreen(
    isAdmin: Boolean,
    onOpenAdmin: () -> Unit,
    onLoggedOut: () -> Unit,
    contentPadding: PaddingValues = PaddingValues(),
) {
    val context = LocalContext.current
    val me by SessionManager.me.collectAsState()
    val scope = rememberCoroutineScope()
    val myStatus by SessionManager.myStatus.collectAsState()
    val prefs by ThemeState.prefs.collectAsState()
    val followSystem by ThemeState.followSystem.collectAsState()
    var showEdit by remember { mutableStateOf(false) }
    var showPassword by remember { mutableStateOf(false) }
    var showStatusText by remember { mutableStateOf(false) }
    var showDevices by remember { mutableStateOf(false) }
    var showTwoFactor by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }
    var uploadingAvatar by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }

    fun savePrefs(next: UserPreferences) {
        ThemeState.update(context, next) // instant, even offline
        scope.launch {
            runCatching { SessionManager.api.updatePreferences(next) }
                .onFailure { snackbar.showSnackbar("Saved on this device — couldn't sync to your account") }
        }
    }

    val pickAvatar = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            uploadingAvatar = true
            runCatching {
                val tmp = File(context.cacheDir, "avatar_upload")
                context.contentResolver.openInputStream(uri)?.use { input -> tmp.outputStream().use { input.copyTo(it) } }
                val mime = context.contentResolver.getType(uri) ?: "image/jpeg"
                val uploaded = try { SessionManager.api.uploadFile(tmp, mime) } finally { tmp.delete() }
                val updated = SessionManager.api.updateSelf(avatarFileId = uploaded.id)
                if (updated.id != 0L) SessionManager.setMe(updated)
            }.onFailure { snackbar.showSnackbar(it.message ?: "Couldn't update your photo") }
            uploadingAvatar = false
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    var batteryExempt by remember { mutableStateOf(isIgnoringBatteryOptimizations(context)) }
    var fullScreenOk by remember { mutableStateOf(canUseFullScreenIntent(context)) }
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                batteryExempt = isIgnoringBatteryOptimizations(context)
                fullScreenOk = canUseFullScreenIntent(context)
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Box(Modifier.fillMaxSize().padding(bottom = contentPadding.calculateBottomPadding())) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            ScreenHeader("Settings")

            // ---- profile card ----
            val accent = MaterialTheme.colorScheme.primary
            Surface(
                shape = MaterialTheme.shapes.extraLarge,
                color = MaterialTheme.colorScheme.surfaceContainer,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            ) {
                Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.clickable { pickAvatar.launch("image/*") }) {
                        Avatar(me?.display_name ?: "?", me?.avatar_file_id, size = 72)
                        if (uploadingAvatar) CircularProgressIndicator(Modifier.size(72.dp), strokeWidth = 3.dp)
                        Box(
                            Modifier.size(26.dp).align(Alignment.BottomEnd).clip(CircleShape).background(accent)
                                .border(2.dp, MaterialTheme.colorScheme.surfaceContainer, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Default.PhotoCamera, "Change photo", tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(14.dp)) }
                    }
                    Column(Modifier.weight(1f).padding(start = 16.dp)) {
                        Text(me?.display_name ?: "", style = MaterialTheme.typography.titleLarge)
                        Text("@${me?.username}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        me?.email?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    FilledTonalIconButton(onClick = { showEdit = true }) { Icon(Icons.Default.Edit, "Edit profile") }
                }
            }

            // ---- status ----
            SectionHeader("Status")
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("online" to "Online", "away" to "Away", "dnd" to "Do not disturb").forEach { (value, label) ->
                    FilterChip(
                        selected = myStatus == value,
                        onClick = { SessionManager.setMyStatus(value) },
                        label = { Text(label) },
                        leadingIcon = { Box(Modifier.size(9.dp).clip(CircleShape).background(presenceColor(value))) },
                        shape = MaterialTheme.shapes.extraLarge,
                    )
                }
            }
            if (myStatus == "dnd") {
                Text(
                    "Message notifications are silenced. Calls still ring.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                )
            }

            // ---- appearance ----
            SectionHeader("Appearance")
            LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                items(ThemePresets, key = { it.id }) { t ->
                    val selected = prefs.theme == t.id
                    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(76.dp).clickable { savePrefs(prefs.copy(theme = t.id)) }) {
                        Box(
                            Modifier.size(76.dp, 96.dp).clip(RoundedCornerShape(16.dp)).background(t.bg)
                                .border(if (selected) 2.5.dp else 1.dp, if (selected) accent else MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp))
                                .padding(8.dp),
                        ) {
                            // a miniature chat: two bubbles in the theme's colors
                            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                                Box(Modifier.fillMaxWidth(0.75f).height(14.dp).clip(RoundedCornerShape(7.dp)).background(t.card))
                                Box(Modifier.fillMaxWidth(0.6f).height(14.dp).align(Alignment.End).clip(RoundedCornerShape(7.dp)).background(accent))
                                Box(Modifier.fillMaxWidth(0.5f).height(14.dp).clip(RoundedCornerShape(7.dp)).background(t.card))
                            }
                            if (selected) Box(
                                Modifier.size(20.dp).align(Alignment.BottomEnd).clip(CircleShape).background(accent),
                                contentAlignment = Alignment.Center,
                            ) { Icon(Icons.Default.Check, null, tint = Color.White, modifier = Modifier.size(13.dp)) }
                        }
                        Text(t.name, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 6.dp), fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal)
                    }
                }
            }
            Text("Accent", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp))
            Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                AccentPresets.forEach { a ->
                    val selected = prefs.accent_color == a.id
                    Box(
                        Modifier.size(40.dp).clip(CircleShape).background(a.color)
                            .border(if (selected) 3.dp else 0.dp, if (selected) MaterialTheme.colorScheme.onSurface else Color.Transparent, CircleShape)
                            .clickable { savePrefs(prefs.copy(accent_color = a.id)) },
                        contentAlignment = Alignment.Center,
                    ) { if (selected) Icon(Icons.Default.Check, a.name, tint = Color.White, modifier = Modifier.size(18.dp)) }
                }
            }
            Text("Corners", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 20.dp, top = 16.dp, bottom = 8.dp))
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                RadiusPresets.forEachIndexed { i, (id, label) ->
                    SegmentedButton(
                        selected = prefs.radius == id,
                        onClick = { savePrefs(prefs.copy(radius = id)) },
                        shape = SegmentedButtonDefaults.itemShape(i, RadiusPresets.size),
                    ) { Text(label) }
                }
            }
            Spacer(Modifier.height(8.dp))
            SectionCard {
                SettingsRow(
                    Icons.Default.BrightnessAuto, "Match system light/dark",
                    subtitle = "Use Light when your phone is in light mode",
                    tint = VcColor.Away,
                    onClick = { ThemeState.setFollowSystem(context, !followSystem) },
                    trailing = { Switch(checked = followSystem, onCheckedChange = { ThemeState.setFollowSystem(context, it) }) },
                )
            }

            // ---- account ----
            SectionHeader("Account")
            SectionCard {
                SettingsRow(Icons.Default.Person, "Edit profile", "Display name and email", onClick = { showEdit = true })
                HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.Password, "Change password", "Signs you out everywhere", tint = VcColor.Online, onClick = { showPassword = true })
                HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.EditNote, "Status message", me?.status_text?.ifBlank { null } ?: "Tell people what you're up to", onClick = { showStatusText = true })
                HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.Shield, "Two-step verification", if (me?.totp_enabled == true) "On" else "Off — add an authenticator app", tint = VcColor.Online, onClick = { showTwoFactor = true })
                HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.Devices, "Signed-in devices", "See and sign out other devices", tint = VcColor.Away, onClick = { showDevices = true })
                if (me?.oidc_linked == true) {
                    HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    SettingsRow(Icons.Default.LinkOff, "Unlink single sign-on", tint = VcColor.Away, onClick = {
                        scope.launch {
                            runCatching { SessionManager.api.oidcUnlink() }
                                .onSuccess { me?.let { SessionManager.setMe(it.copy(oidc_linked = false)) }; snackbar.showSnackbar("Single sign-on unlinked") }
                                .onFailure { snackbar.showSnackbar(it.message ?: "Couldn't unlink") }
                        }
                    })
                }
            }

            // ---- device ----
            SectionHeader("This device")
            SectionCard {
                if (!batteryExempt) {
                    SettingsRow(
                        Icons.Default.BatteryAlert, "Allow running in background",
                        subtitle = "Needed to receive calls when the app is closed (no push service on a private network)",
                        tint = VcColor.Danger,
                        onClick = { requestIgnoreBatteryOptimizations(context) },
                    )
                    HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                }
                if (!fullScreenOk) {
                    SettingsRow(
                        Icons.Default.PhoneInTalk, "Show calls on the lock screen",
                        subtitle = "Lets incoming calls open full screen, like a regular phone call",
                        tint = VcColor.Danger,
                        onClick = { requestFullScreenIntent(context) },
                    )
                    HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                }
                KeyBackupSettings(showMessage = { msg -> scope.launch { snackbar.showSnackbar(msg) } })
                HorizontalDivider(Modifier.padding(start = 64.dp), color = MaterialTheme.colorScheme.outlineVariant)
                SettingsRow(Icons.Default.Dns, "Server", Prefs.serverUrl(context) ?: "—", tint = MaterialTheme.colorScheme.secondary)
            }

            if (isAdmin) {
                SectionHeader("Administration")
                SectionCard {
                    SettingsRow(Icons.Default.AdminPanelSettings, "Admin dashboard", "Users, server settings, audit log", onClick = onOpenAdmin)
                }
            }

            Spacer(Modifier.height(20.dp))
            SectionCard {
                SettingsRow(
                    Icons.AutoMirrored.Filled.Logout, "Sign out", tint = MaterialTheme.colorScheme.error,
                    titleColor = MaterialTheme.colorScheme.error, onClick = { confirmLogout = true }, trailing = null,
                )
            }
            Text(
                "Vision Call for Android · v${appVersion(context)}",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(top = 16.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }

    if (showEdit) EditProfileSheet(onDismiss = { showEdit = false })
    if (showPassword) ChangePasswordSheet(onDismiss = { showPassword = false })
    if (showStatusText) StatusTextSheet(onDismiss = { showStatusText = false })
    if (showDevices) DevicesSheet(onDismiss = { showDevices = false })
    if (showTwoFactor) TwoFactorSheet(onDismiss = { showTwoFactor = false })
    if (confirmLogout) {
        ConfirmDialog(
            title = "Sign out?",
            message = "You won't receive calls or messages on this device until you sign in again.",
            confirmLabel = "Sign out",
            onConfirm = { scope.launch { SessionManager.logout(); onLoggedOut() } },
            onDismiss = { confirmLogout = false },
        )
    }
}

private fun appVersion(ctx: android.content.Context): String =
    runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: ""

@Composable
private fun EditProfileSheet(onDismiss: () -> Unit) {
    val me by SessionManager.me.collectAsState()
    val scope = rememberCoroutineScope()
    var displayName by remember { mutableStateOf(me?.display_name ?: "") }
    var email by remember { mutableStateOf(me?.email ?: "") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("Edit profile", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(displayName, { displayName = it.take(64) }, label = { Text("Display name") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium)
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                email, { email = it }, label = { Text("Email") }, singleLine = true, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
                supportingText = { Text("Used for password reset links") },
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 6.dp)) }
            Spacer(Modifier.height(12.dp))
            PrimaryButton("Save", enabled = displayName.isNotBlank(), busy = saving, onClick = {
                saving = true
                scope.launch {
                    runCatching { SessionManager.api.updateSelf(displayName = displayName.trim(), email = email.trim()) }
                        .onSuccess { if (it.id != 0L) SessionManager.setMe(it); onDismiss() }
                        .onFailure { error = it.message ?: "Couldn't save" }
                    saving = false
                }
            })
        }
    }
}

@Composable
private fun ChangePasswordSheet(onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val mismatch = confirm.isNotEmpty() && confirm != next

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("Change password", style = MaterialTheme.typography.titleLarge)
            Text("You'll be signed out on every device and asked to sign in again.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(current, { current = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium)
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                next, { next = it }, label = { Text("New password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(),
                supportingText = { Text("At least 8 characters") }, isError = next.isNotEmpty() && next.length < 8,
                modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
            )
            OutlinedTextField(
                confirm, { confirm = it }, label = { Text("Confirm new password") }, singleLine = true, visualTransformation = PasswordVisualTransformation(),
                isError = mismatch, supportingText = { if (mismatch) Text("Passwords don't match") },
                modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 6.dp)) }
            Spacer(Modifier.height(12.dp))
            PrimaryButton(
                "Change password",
                enabled = current.isNotEmpty() && next.length >= 8 && next == confirm,
                busy = saving,
                onClick = {
                    saving = true
                    scope.launch {
                        // Success revokes every session including this one; the
                        // server's force:logout then returns the app to Login.
                        runCatching { SessionManager.api.updateSelf(currentPassword = current, newPassword = next) }
                            .onSuccess { onDismiss() }
                            .onFailure { error = it.message ?: "Couldn't change password" }
                        saving = false
                    }
                },
            )
        }
    }
}
