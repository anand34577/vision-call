package com.videocall.mobile.ui.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import com.videocall.mobile.session.SessionManager
import com.videocall.mobile.ui.components.PrimaryButton

/** Shown instead of the app while an admin-set password is still in use. */
@Composable
fun ForcePasswordScreen() {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val mismatch = confirm.isNotEmpty() && confirm != next

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).systemBarsPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Choose a new password", style = MaterialTheme.typography.headlineSmall)
        Text(
            "An administrator set your current password. Pick your own before continuing.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp, bottom = 20.dp),
        )
        val pw = PasswordVisualTransformation()
        val kb = KeyboardOptions(keyboardType = KeyboardType.Password)
        OutlinedTextField(current, { current = it }, label = { Text("Current password") }, singleLine = true, visualTransformation = pw, keyboardOptions = kb, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(next, { next = it }, label = { Text("New password") }, supportingText = { Text("At least 8 characters") }, singleLine = true, visualTransformation = pw, keyboardOptions = kb, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            confirm, { confirm = it }, label = { Text("Confirm new password") }, singleLine = true, visualTransformation = pw, keyboardOptions = kb,
            isError = mismatch, supportingText = { if (mismatch) Text("Passwords don't match") }, modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        PrimaryButton("Change password", enabled = current.isNotEmpty() && next.length >= 8 && next == confirm, busy = busy, onClick = {
            busy = true
            error = null
            scope.launch {
                // On success the server has signed every device out; do the same here and return to sign-in.
                runCatching { SessionManager.api.updateSelf(currentPassword = current, newPassword = next) }
                    .onSuccess { SessionManager.signOutWithReason("password_changed") }
                    .onFailure { error = it.message ?: "Could not change password"; busy = false }
            }
        })
        TextButton(onClick = { scope.launch { SessionManager.logout() } }, modifier = Modifier.fillMaxWidth()) { Text("Sign out") }
    }
}
