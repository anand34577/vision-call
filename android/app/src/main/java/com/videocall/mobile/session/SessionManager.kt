package com.videocall.mobile.session

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import com.videocall.mobile.net.Api
import com.videocall.mobile.net.Prefs
import com.videocall.mobile.net.User
import com.videocall.mobile.net.WsClient
import com.videocall.mobile.net.long
import com.videocall.mobile.net.obj
import com.videocall.mobile.net.str

/**
 * App-wide singleton: the logged-in user, the REST client, and the realtime
 * WebSocket. Everything else (chat repo, call repo) reads from this instead
 * of each owning its own connection.
 */
object SessionManager {
    private lateinit var appContext: Context
    lateinit var api: Api
        private set
    lateinit var ws: WsClient
        private set

    private val _me = MutableStateFlow<User?>(null)
    val me: StateFlow<User?> = _me

    // The people directory, kept fresh for @mentions and pickers.
    private val _users = MutableStateFlow<List<User>>(emptyList())
    val users: StateFlow<List<User>> = _users
    fun refreshUsers() {
        if (!hasServer || _me.value == null) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { api.users() }.onSuccess { _users.value = it }
        }
    }

    // Bumped when an admin adds, changes or removes people, so open screens reload the directory.
    private val _directoryVersion = MutableStateFlow(0)
    val directoryVersion: StateFlow<Int> = _directoryVersion

    // user_id -> status ("online"/"away"/"dnd"/"offline")
    private val _presence = MutableStateFlow<Map<Long, String>>(emptyMap())
    val presence: StateFlow<Map<Long, String>> = _presence

    // The user's own last explicitly-chosen status (e.g. "online"/"dnd"), kept
    // separately from _presence so a WS reconnect can re-assert it instead of
    // always forcing "online" and silently clearing a user-set DND.
    private val _myStatus = MutableStateFlow("online")
    val myStatus: StateFlow<String> = _myStatus

    // Why the server signed us out, shown once on the sign-in screen.
    private var logoutReason: String? = null
    fun consumeLogoutReason(): String? = logoutReason.also { logoutReason = null }

    private val logoutMessages = mapOf(
        "signed_in_elsewhere" to "You were signed out because your account was signed in on another device.",
        "suspended" to "Your account has been suspended by an administrator.",
        "deleted" to "Your account has been removed by an administrator.",
        "password_changed" to "Your password was changed. Please sign in with the new password.",
        "signed_out" to "An administrator signed you out. Please sign in again.",
        "signed_out_remotely" to "This device was signed out from another device.",
    )

    fun init(context: Context) {
        appContext = context.applicationContext
        val server = Prefs.serverUrl(appContext) ?: return
        bind(server)
    }

    fun bind(serverUrl: String) {
        api = Api(appContext, serverUrl)
        ws = WsClient(api, Prefs.deviceId(appContext))
        ws.onReconnecting = { pending -> keepAwakeWhileReconnecting(pending) }
        _myStatus.value = Prefs.myStatus(appContext)
        api.onUnauthorized = { logoutReason = "Your session expired. Please sign in again."; logoutLocal() }
        ws.onAuthFailed = { logoutReason = "Your session expired. Please sign in again."; logoutLocal() }
        // Every bind() (e.g. switching servers mid-session) creates a fresh
        // WsClient, so handlers must be re-attached to it each time, else
        // incoming events keep being delivered to the orphaned old socket.
        registerWsHandlers()
        com.videocall.mobile.call.CallRepository.registerOnce(appContext)
        com.videocall.mobile.chat.ChatRepository.init(appContext)
        com.videocall.mobile.chat.ChatRepository.registerOnce()
    }

    private var reconnectWakeLock: android.os.PowerManager.WakeLock? = null

    // A partial wake lock only while a reconnect is pending (never while
    // connected), capped at 10 minutes per attempt so it can't drain the battery.
    private fun keepAwakeWhileReconnecting(pending: Boolean) {
        val pm = appContext.getSystemService(android.os.PowerManager::class.java) ?: return
        if (pending) {
            val lock = reconnectWakeLock ?: pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "visioncall:reconnect")
                .also { it.setReferenceCounted(false); reconnectWakeLock = it }
            lock.acquire(10 * 60 * 1000L)
        } else {
            reconnectWakeLock?.let { if (it.isHeld) it.release() }
        }
    }

    val hasServer: Boolean get() = ::api.isInitialized

    /**
     * Picks the saved session back up. Only a definite "not signed in" answer
     * (401/403) counts as signed out; if the server just can't be reached
     * right now (no network yet, VPN still connecting) the app opens with the
     * last known account and keeps retrying in the background instead of
     * bouncing to the sign-in screen.
     */
    suspend fun tryResume(): Boolean {
        if (!hasServer) return false
        return try {
            onSignedIn(api.me())
            true
        } catch (e: com.videocall.mobile.net.ApiException) {
            if (e.status == 401 || e.status == 403) {
                Prefs.setCachedUser(appContext, null)
                false
            } else offlineResume()
        } catch (e: Exception) {
            offlineResume()
        }
    }

    private fun offlineResume(): Boolean {
        val cached = Prefs.cachedUser(appContext)?.let {
            runCatching { com.videocall.mobile.net.json.decodeFromString<User>(it) }.getOrNull()
        } ?: return false
        onSignedIn(cached)
        return true
    }

    suspend fun login(username: String, password: String, totpCode: String? = null): Result<User> = runCatching {
        val user = api.login(username, password, totpCode)
        onSignedIn(user)
        user
    }

    /** Shared by password login, OIDC login and a resumed session. */
    fun onSignedIn(user: User) {
        _me.value = user
        cacheUser(user)
        user.preferences?.let { com.videocall.mobile.ui.theme.ThemeState.applyServer(appContext, it) }
        ws.connect()
        ConnectionService.start(appContext)
        UnreadPollJob.schedule(appContext)
        com.videocall.mobile.chat.ChatRepository.onSignedIn()
    }

    private fun cacheUser(user: User) {
        if (::appContext.isInitialized) runCatching {
            Prefs.setCachedUser(appContext, com.videocall.mobile.net.json.encodeToString(User.serializer(), user.copy(status = "offline")))
        }
    }

    /** Signs out on this device with one of the standard explanations (a key of [logoutMessages]). */
    fun signOutWithReason(reason: String) {
        logoutReason = logoutMessages[reason]
        logoutLocal()
    }

    fun logoutLocal() {
        if (_me.value == null && !ws.connected) return
        if (::appContext.isInitialized) Prefs.setCachedUser(appContext, null)
        _me.value = null
        ws.disconnect()
        if (::appContext.isInitialized) { ConnectionService.stop(appContext); UnreadPollJob.cancel(appContext) }
        com.videocall.mobile.call.CallRepository.hangup()
        com.videocall.mobile.chat.ChatRepository.clear()
        com.videocall.mobile.chat.Crypto.clearOnLogout()
        _presence.value = emptyMap()
        _users.value = emptyList()
    }

    suspend fun logout() {
        runCatching { api.logout() }
        logoutLocal()
        logoutReason = null // a deliberate sign-out needs no explanation
    }

    fun setMe(user: User) {
        // PATCH /api/users/me also returns preferences; keep the previous ones if absent.
        val merged = if (user.preferences == null) user.copy(preferences = _me.value?.preferences) else user
        _me.value = merged
        cacheUser(merged)
    }

    fun setMyStatus(status: String) {
        _myStatus.value = status
        if (::appContext.isInitialized) Prefs.setMyStatus(appContext, status)
        ws.send("presence:update", mapOf("status" to status))
    }

    private fun registerWsHandlers() {
        ws.on("presence:sync") { data ->
            // Server sends {"users": [{"user_id":1,"status":"online"}, ...]}, not
            // a bare id->status map (see web/src/App.tsx's presence:sync handler).
            val users = data.obj()["users"] as? kotlinx.serialization.json.JsonArray ?: return@on
            val map = mutableMapOf<Long, String>()
            for (entry in users) {
                val o = entry as? kotlinx.serialization.json.JsonObject ?: continue
                val id = o.long("user_id") ?: continue
                val status = o.str("status") ?: continue
                map[id] = status
            }
            _presence.value = map
        }
        ws.on("presence:update") { data ->
            val id = data.long("user_id") ?: return@on
            val status = data.str("status") ?: return@on
            _presence.value = _presence.value.toMutableMap().apply { put(id, status) }
        }
        ws.on("directory:changed") { _directoryVersion.value += 1; refreshUsers() }
        ws.on("force:logout") { data ->
            logoutReason = logoutMessages[data.str("reason")] ?: "You were signed out. Please sign in again."
            logoutLocal()
        }
        // An admin changed this account (for example its role): reload it.
        ws.on("account:updated") {
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { api.me() }.onSuccess { setMe(it) }
            }
        }
        // Re-assert our last chosen status on (re)connect — must NOT hardcode
        // "online" here, or a user-set DND silently gets cleared on every
        // automatic reconnect (network blip, app foreground/background).
        ws.on("ws:open") { ws.send("presence:update", mapOf("status" to _myStatus.value)); refreshUsers() }
    }
}
