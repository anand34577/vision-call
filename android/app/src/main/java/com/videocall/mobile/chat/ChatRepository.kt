package com.videocall.mobile.chat

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.withContext
import java.io.File
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import com.videocall.mobile.net.Group
import com.videocall.mobile.net.ConvoPref
import com.videocall.mobile.net.Message
import com.videocall.mobile.net.json
import com.videocall.mobile.net.long
import com.videocall.mobile.net.obj
import com.videocall.mobile.net.str
import com.videocall.mobile.session.SessionManager

sealed class Convo {
    data class Dm(val peerId: Long) : Convo()
    data class GroupChat(val groupId: Long) : Convo()
    val key: String get() = when (this) { is Dm -> "dm:$peerId"; is GroupChat -> "g:$groupId" }
}

/**
 * Mirrors web/src/store/chats.ts: realtime messages, unread counts, typing,
 * edit/delete/react/pin, per-conversation E2E encryption toggle (via
 * chat/Crypto.kt), search/pinned/saved lists.
 */
object ChatRepository {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var appContext: Context

    private val _messages = MutableStateFlow<Map<String, List<Message>>>(emptyMap())
    val messages: StateFlow<Map<String, List<Message>>> = _messages

    private val _unread = MutableStateFlow<Map<String, Int>>(emptyMap())
    val unread: StateFlow<Map<String, Int>> = _unread

    private val _groups = MutableStateFlow<List<Group>>(emptyList())
    val groups: StateFlow<List<Group>> = _groups

    private val _typing = MutableStateFlow<Map<String, String>>(emptyMap()) // convoKey -> "Ann" or "Ann, Bo"
    // convoKey -> userId -> (name, expiry). Tracked per person so two people
    // typing both show, and one person's old timer can't clear a newer one.
    private val typers = mutableMapOf<String, MutableMap<Long, Pair<String, Long>>>()

    private fun publishTyping() {
        val now = System.currentTimeMillis()
        val out = mutableMapOf<String, String>()
        val it = typers.entries.iterator()
        while (it.hasNext()) {
            val (k, m) = it.next()
            m.values.removeAll { p -> p.second < now }
            if (m.isEmpty()) it.remove() else out[k] = m.values.joinToString(", ") { p -> p.first }
        }
        _typing.value = out
    }

    // convoKey ("dm:5" / "g:3") -> mute/archive settings.
    private val _prefs = MutableStateFlow<Map<String, ConvoPref>>(emptyMap())
    val prefs: StateFlow<Map<String, ConvoPref>> = _prefs

    // groupId -> userId -> id of the last message that person has read.
    private val _groupReads = MutableStateFlow<Map<Long, Map<Long, Long>>>(emptyMap())
    val groupReads: StateFlow<Map<Long, Map<Long, Long>>> = _groupReads

    private fun prefKey(p: ConvoPref) = if (p.kind == "dm") "dm:${p.target_id}" else "g:${p.target_id}"

    suspend fun loadPrefs() {
        val list = runCatching { SessionManager.api.convoPrefs() }.getOrNull() ?: return
        _prefs.value = list.associateBy { prefKey(it) }
    }

    fun setPref(convo: Convo, muted: Boolean? = null, archived: Boolean? = null) {
        val cur = _prefs.value[convo.key]
        val next = ConvoPref(
            kind = if (convo is Convo.Dm) "dm" else "group",
            target_id = when (convo) { is Convo.Dm -> convo.peerId; is Convo.GroupChat -> convo.groupId },
            muted = muted ?: cur?.muted ?: false,
            archived = archived ?: cur?.archived ?: false,
        )
        _prefs.value = _prefs.value + (convo.key to next)
        scope.launch {
            if (runCatching { SessionManager.api.setConvoPref(next) }.isFailure) {
                _prefs.value = if (cur != null) _prefs.value + (convo.key to cur) else _prefs.value - convo.key
            }
        }
    }

    fun isMuted(key: String) = _prefs.value[key]?.muted == true

    suspend fun loadGroupReads(groupId: Long) {
        val r = runCatching { SessionManager.api.groupReadState(groupId) }.getOrNull() ?: return
        _groupReads.value = _groupReads.value + (groupId to r.mapNotNull { (k, v) -> k.toLongOrNull()?.let { it to v } }.toMap())
    }

    /** ids of users @-mentioned in [text], resolved against the people directory. */
    private fun mentionIds(text: String): List<Long> {
        val users = SessionManager.users.value
        return Regex("(?:^|\\s)@([a-zA-Z0-9._-]{2,32})").findAll(text)
            .mapNotNull { m -> users.firstOrNull { it.username.equals(m.groupValues[1], true) }?.id }
            .distinct().toList()
    }

    private val _encryptedConvos = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val encryptedConvos: StateFlow<Map<String, Boolean>> = _encryptedConvos

    private val _savedIds = MutableStateFlow<Set<Long>>(emptySet())
    val savedIds: StateFlow<Set<Long>> = _savedIds

    // convoKey -> whether older history exists beyond what's loaded
    private val _hasMore = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val hasMore: StateFlow<Map<String, Boolean>> = _hasMore
    private val _loadingOlder = MutableStateFlow<Set<String>>(emptySet())
    val loadingOlder: StateFlow<Set<String>> = _loadingOlder

    // Last send failure worth telling the user about (shown once, then cleared).
    private val _sendError = MutableStateFlow<String?>(null)
    val sendError: StateFlow<String?> = _sendError
    fun clearSendError() { _sendError.value = null }

    // clientId -> (convo, optimistic id, timeout job) for sends awaiting message:sent.
    private val pendingAcks = mutableMapOf<String, Triple<Convo, Long, kotlinx.coroutines.Job>>()

    // Monotonic source for optimistic message ids — System.currentTimeMillis()
    // collided when two messages were sent within the same millisecond,
    // silently overwriting the first optimistic bubble until its ack arrived.
    private val optimisticIdSeq = AtomicLong(0)

    private var activeConvo: Convo? = null

    // "v2": earlier versions stored a guess (copied from the last message) for
    // every chat opened, which would now read as a deliberate "off".
    private fun e2ePrefs(context: Context) = context.getSharedPreferences("vc_e2e_flags_v2", Context.MODE_PRIVATE)

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /** Called once a session exists (login or resumed session). */
    fun onSignedIn() {
        SessionManager.refreshUsers()
        scope.launch {
            if (::appContext.isInitialized) Crypto.ensureDeviceRegistered(appContext)
        }
        // Show what was on screen last time straight away; the network then refreshes it.
        loadDiskCache()
        startCacheWriter()
        scope.launch { loadGroups(); fetchRecent(); fetchSaved(); loadPrefs(); loadBlocked() }
    }

    /** Drops everything the previous account could see (shared devices). */
    fun clear() {
        pendingAcks.values.forEach { it.third.cancel() }
        pendingAcks.clear()
        _messages.value = emptyMap()
        _unread.value = emptyMap()
        _groups.value = emptyList()
        _typing.value = emptyMap()
        _encryptedConvos.value = emptyMap()
        _savedIds.value = emptySet()
        _hasMore.value = emptyMap()
        _prefs.value = emptyMap()
        _groupReads.value = emptyMap()
        _blocked.value = emptySet()
        typers.clear()
        activeConvo = null
        deleteDiskCache()
    }

    fun isEncrypted(convo: Convo): Boolean = _encryptedConvos.value[convo.key] ?: false

    fun setEncrypted(convo: Convo, on: Boolean) {
        _encryptedConvos.value = _encryptedConvos.value.toMutableMap().apply { put(convo.key, on) }
        if (::appContext.isInitialized) e2ePrefs(appContext).edit().putBoolean(convo.key, on).apply()
    }

    private fun loadEncryptedFlag(convo: Convo) {
        if (_encryptedConvos.value.containsKey(convo.key)) return
        if (!::appContext.isInitialized) return
        // Chats are end-to-end encrypted unless someone turned it off for this chat.
        val stored = e2ePrefs(appContext).contains(convo.key)
        val value = if (stored) e2ePrefs(appContext).getBoolean(convo.key, true) else true
        _encryptedConvos.value = _encryptedConvos.value.toMutableMap().apply { put(convo.key, value) }
    }

    fun setActive(convo: Convo?) {
        activeConvo = convo
        if (convo != null) {
            markRead(convo)
            if (::appContext.isInitialized) {
                runCatching { androidx.core.app.NotificationManagerCompat.from(appContext).cancel(convo.key.hashCode()) }
            }
        }
    }

    // Re-attaches handlers to the current SessionManager.ws; called on every
    // SessionManager.bind() (including server switches), since each bind()
    // creates a brand-new WsClient that needs its own listeners.
    fun registerOnce() {
        val ws = SessionManager.ws

        // Anything sent while the socket was down never reached us (group
        // messages in particular are not re-delivered), so resync on reconnect.
        ws.on("ws:open") { _ ->
            if (SessionManager.me.value == null) return@on
            scope.launch {
                loadGroups()
                fetchRecent()
                loadPrefs()
                activeConvo?.let { loadHistory(it) }
                resendFailed()
            }
        }
        ws.on("group:changed") { _ -> scope.launch { loadGroups() } }
        ws.on("poll:updated") { d ->
            val id = d.long("message_id") ?: return@on
            val poll = runCatching { json.decodeFromJsonElement<com.videocall.mobile.net.Poll>(d.obj()["poll"] ?: return@on) }.getOrNull() ?: return@on
            mutateEverywhere(id) { it.copy(poll = poll) }
        }
        ws.on("blocks:changed") { _ -> scope.launch { loadBlocked() } }
        ws.on("conversation:prefs") { d ->
            val p = runCatching { json.decodeFromJsonElement<ConvoPref>(d) }.getOrNull() ?: return@on
            _prefs.value = _prefs.value + (prefKey(p) to p)
        }
        ws.on("message:group-read") { d ->
            val gid = d.long("group_id") ?: return@on
            val from = d.long("from") ?: return@on
            val last = d.long("last_read_id") ?: return@on
            _groupReads.value = _groupReads.value + (gid to ((_groupReads.value[gid] ?: emptyMap()) + (from to last)))
        }
        // A rejected send (not a group member, too long, rate-limited...) comes
        // back as an "error" carrying our client_id; fail that bubble now
        // instead of leaving it "Sending..." forever.
        ws.on("error") { d ->
            val clientId = d.str("client_id") ?: return@on
            val pending = pendingAcks.remove(clientId) ?: return@on
            pending.third.cancel()
            markFailed(pending.first, pending.second)
            _sendError.value = d.str("message") ?: "Message not sent"
        }

        ws.on("message:new") { d ->
            val msg = decodeMessage(d.obj()["message"] ?: return@on) ?: return@on
            val me = SessionManager.me.value ?: return@on
            val convo: Convo = when {
                msg.recipient_id == me.id -> Convo.Dm(msg.sender_id)
                msg.group_id != null -> Convo.GroupChat(msg.group_id)
                else -> return@on
            }
            val existed = (_messages.value[convo.key] ?: emptyList()).any { it.id == msg.id }
            appendMessage(convo, msg)
            if (!existed) bumpThread(convo, msg)
            decryptPending(convo, listOf(msg))
            if (activeConvo != convo) {
                _unread.value = _unread.value.toMutableMap().apply { put(convo.key, (get(convo.key) ?: 0) + 1) }
                // On the call screen for this chat, the call shows its own
                // banner and badge instead of a notification on top of it.
                val call = com.videocall.mobile.call.CallRepository.state.value
                val inThisCall = com.videocall.mobile.App.isInForeground && call.status == com.videocall.mobile.call.CallStatus.ACTIVE &&
                    ((convo is Convo.Dm && call.peer?.id == convo.peerId) || (convo is Convo.GroupChat && call.group?.id == convo.groupId))
                val mentioned = msg.mentions?.contains(me.id) == true
                val silenced = (isMuted(convo.key) && !mentioned) || SessionManager.myStatus.value == "dnd"
                if (::appContext.isInitialized && !inThisCall && !silenced) ChatNotifier.notifyNewMessage(appContext, convo, msg, me, _groups.value)
            } else {
                markRead(convo)
            }
        }
        ws.on("message:sent") { d ->
            val msg = decodeMessage(d.obj()["message"] ?: return@on) ?: return@on
            val convo: Convo = if (msg.group_id != null) Convo.GroupChat(msg.group_id) else Convo.Dm(msg.recipient_id ?: return@on)
            d.str("client_id")?.let { pendingAcks.remove(it)?.third?.cancel() }
            val existed = (_messages.value[convo.key] ?: emptyList()).any { it.id == msg.id }
            replaceOptimistic(convo, d.str("client_id"), msg)
            if (!existed) bumpThread(convo, msg)
            decryptPending(convo, listOf(msg))
        }
        ws.on("message:unread") { d ->
            val counts = d.obj()["counts"]?.obj() ?: JsonObject(emptyMap())
            val groupCounts = d.obj()["group_counts"]?.obj() ?: JsonObject(emptyMap())
            val map = mutableMapOf<String, Int>()
            for ((k, v) in counts) (v as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull()?.let { map["dm:$k"] = it }
            for ((k, v) in groupCounts) (v as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull()?.let { map["g:$k"] = it }
            _unread.value = map
        }
        ws.on("message:typing") { d ->
            val name = d.str("from_name") ?: "Someone"
            val from = d.long("from") ?: return@on
            val key = d.long("group_id")?.let { "g:$it" } ?: "dm:$from"
            typers.getOrPut(key) { mutableMapOf() }[from] = name to System.currentTimeMillis() + 3500
            publishTyping()
            scope.launch {
                kotlinx.coroutines.delay(3600)
                publishTyping()
            }
        }
        ws.on("message:read") { d ->
            val from = d.long("from") ?: return@on
            val me = SessionManager.me.value ?: return@on
            val key = "dm:$from"
            val list = (_messages.value[key] ?: emptyList()).map {
                if (it.sender_id == me.id && it.recipient_id == from && it.read_at == null) it.copy(read_at = "now") else it
            }
            _messages.value = _messages.value.toMutableMap().apply { put(key, list) }
        }
        ws.on("message:deleted") { d ->
            val id = d.long("id") ?: return@on
            mutateEverywhere(id) { it.copy(deleted_at = "now", content = "") }
        }
        ws.on("message:edited") { d ->
            val msg = decodeMessage(d.obj()["message"] ?: return@on) ?: return@on
            mutateEverywhere(msg.id) { msg }
        }
        ws.on("message:pinned") { d ->
            val id = d.long("id") ?: return@on
            val pinnedAt = d.str("pinned_at")
            mutateEverywhere(id) { it.copy(pinned_at = pinnedAt) }
        }
        ws.on("message:reaction") { d ->
            val id = d.long("id") ?: return@on
            val userId = d.long("user_id") ?: return@on
            val emoji = d.str("emoji") ?: return@on
            val added = d.bool2("added")
            mutateEverywhere(id) { m ->
                val without = (m.reactions ?: emptyList()).filterNot { it.user_id == userId && it.emoji == emoji }
                m.copy(reactions = if (added) without + com.videocall.mobile.net.MessageReaction(id, userId, emoji) else without)
            }
        }
    }

    private fun kotlinx.serialization.json.JsonElement.bool2(key: String): Boolean =
        (this as? JsonObject)?.get(key)?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull() } ?: false

    private fun decodeMessage(el: kotlinx.serialization.json.JsonElement): Message? =
        runCatching { json.decodeFromJsonElement<Message>(el) }.getOrNull()

    private fun appendMessage(convo: Convo, msg: Message) {
        val list = (_messages.value[convo.key] ?: emptyList()).filter { it.id != msg.id } + msg
        _messages.value = _messages.value.toMutableMap().apply { put(convo.key, list.sortedWith(::messageOrder)) }
    }

    private fun replaceOptimistic(convo: Convo, clientId: String?, msg: Message) {
        val list = (_messages.value[convo.key] ?: emptyList()).filter { it.clientId != clientId && it.id != msg.id } + msg
        _messages.value = _messages.value.toMutableMap().apply { put(convo.key, list.sortedWith(::messageOrder)) }
    }

    // Mirrors web's messageOrder: chronological by sent_at, falling back to
    // id when timestamps tie or are missing (e.g. a not-yet-acked optimistic
    // message) — sorting raw negative optimistic ids ascending would shove
    // an in-flight message to the top of the list instead of the bottom.
    private fun messageOrder(a: Message, b: Message): Int {
        val ta = runCatching { java.time.Instant.parse(a.sent_at) }.getOrNull()
        val tb = runCatching { java.time.Instant.parse(b.sent_at) }.getOrNull()
        if (ta != null && tb != null) {
            val cmp = ta.compareTo(tb)
            if (cmp != 0) return cmp
        }
        return a.id.compareTo(b.id)
    }

    private fun mutateEverywhere(id: Long, fn: (Message) -> Message) {
        _messages.value = _messages.value.mapValues { (_, list) -> list.map { if (it.id == id) fn(it) else it } }
    }

    fun typingIn(convo: Convo): StateFlow<Map<String, String>> = _typing

    private suspend fun fetchPage(convo: Convo, before: Long?): List<Message>? {
        val api = SessionManager.api
        return runCatching {
            when (convo) {
                is Convo.Dm -> api.directMessages(convo.peerId, before)
                is Convo.GroupChat -> api.groupMessages(convo.groupId, before)
            }
        }.getOrNull()
    }

    /** Merges fetched messages into a conversation, keeping in-flight/failed optimistic bubbles. */
    private fun merge(convo: Convo, fetched: List<Message>) {
        val byId = LinkedHashMap<Long, Message>()
        (_messages.value[convo.key] ?: emptyList()).forEach { byId[it.id] = it }
        fetched.forEach { m -> byId[m.id] = m.copy(decryptedContent = byId[m.id]?.decryptedContent) }
        _messages.value = _messages.value.toMutableMap().apply { put(convo.key, byId.values.sortedWith(::messageOrder)) }
    }

    suspend fun loadHistory(convo: Convo) {
        loadEncryptedFlag(convo)
        val list = fetchPage(convo, null) ?: return
        merge(convo, list)
        _hasMore.value = _hasMore.value + (convo.key to (list.size >= 50))
        decryptPending(convo, list)
    }

    /** Pages in the 50 messages before the oldest one loaded. */
    suspend fun loadOlder(convo: Convo) {
        if (_hasMore.value[convo.key] != true || convo.key in _loadingOlder.value) return
        val oldest = (_messages.value[convo.key] ?: emptyList()).firstOrNull { it.id > 0 }?.id ?: return
        _loadingOlder.value = _loadingOlder.value + convo.key
        val list = fetchPage(convo, oldest)
        _loadingOlder.value = _loadingOlder.value - convo.key
        if (list == null) return
        merge(convo, list)
        _hasMore.value = _hasMore.value + (convo.key to (list.size >= 50))
        decryptPending(convo, list)
    }

    /** Seeds each conversation with its latest message for chat-list previews. */
    suspend fun fetchRecent() {
        val me = SessionManager.me.value ?: return
        val recent = runCatching { SessionManager.api.recentConversations() }.getOrNull() ?: return
        val all = (recent.dms ?: emptyList()) + (recent.groups ?: emptyList())
        for (m in all) {
            val convo = when {
                m.group_id != null -> Convo.GroupChat(m.group_id)
                m.sender_id == me.id -> Convo.Dm(m.recipient_id ?: continue)
                else -> Convo.Dm(m.sender_id)
            }
            if ((_messages.value[convo.key] ?: emptyList()).none { it.id == m.id }) merge(convo, listOf(m))
            decryptPending(convo, listOf(m))
        }
    }

    private fun e2ePrefsHas(convo: Convo): Boolean = ::appContext.isInitialized && e2ePrefs(appContext).contains(convo.key)

    /** Tries every encrypted message again, e.g. after restoring the key backup. */
    fun redecryptAll() {
        val cleared = _messages.value.mapValues { (_, list) -> list.map { if (it.is_encrypted) it.copy(decryptedContent = null) else it } }
        _messages.value = cleared
        cleared.forEach { (key, list) ->
            val convo = when {
                key.startsWith("dm:") -> key.removePrefix("dm:").toLongOrNull()?.let { Convo.Dm(it) }
                key.startsWith("g:") -> key.removePrefix("g:").toLongOrNull()?.let { Convo.GroupChat(it) }
                else -> null
            }
            if (convo != null) decryptPending(convo, list)
        }
    }

    private fun decryptPending(convo: Convo, msgs: List<Message>) {
        val encrypted = msgs.filter { it.is_encrypted && it.decryptedContent == null }
        if (encrypted.isEmpty() || !::appContext.isInitialized) return
        scope.launch {
            for (m in encrypted) {
                val plain = runCatching {
                    Crypto.decryptMessageContent(appContext, m.id, m.is_encrypted, m.content, m.enc_iv, m.enc_keys)
                }.getOrNull()
                mutateEverywhere(m.id) { it.copy(decryptedContent = plain ?: "Can't decrypt this message on this device") }
            }
        }
    }

    suspend fun loadGroups() {
        _groups.value = runCatching { SessionManager.api.groups() }.getOrDefault(emptyList())
    }

    fun sendMessage(convo: Convo, content: String, fileId: Long? = null, replyToId: Long? = null, threadRootId: Long? = null, poll: PollDraft? = null) {
        val text = content.trim()
        if (text.isEmpty() && fileId == null) return
        val me = SessionManager.me.value ?: return
        val clientId = "c-${UUID.randomUUID()}"
        val optimistic = Message(
            id = -optimisticIdSeq.incrementAndGet(),
            sender_id = me.id,
            recipient_id = (convo as? Convo.Dm)?.peerId,
            group_id = (convo as? Convo.GroupChat)?.groupId,
            file_id = fileId,
            content = text,
            sent_at = java.time.Instant.now().toString(),
            reply_to_id = replyToId,
            thread_root_id = threadRootId,
            clientId = clientId,
            pending = true,
            decryptedContent = text,
        )
        appendMessage(convo, optimistic)
        // Same 10 s ack deadline as the web client: no message:sent by then means it failed.
        pendingAcks[clientId] = Triple(convo, optimistic.id, scope.launch {
            kotlinx.coroutines.delay(10_000)
            if (pendingAcks.remove(clientId) != null) {
                markFailed(convo, optimistic.id)
                _sendError.value = "Message not sent. Check your connection."
            }
        })

        if (poll != null) {
            // Polls are stored readable (the server tallies votes), so never encrypted.
            val ok = SessionManager.ws.send("message:send", mapOf(
                "client_id" to clientId,
                "recipient_id" to (convo as? Convo.Dm)?.peerId,
                "group_id" to (convo as? Convo.GroupChat)?.groupId,
                "content" to text,
                "poll" to mapOf("question" to text, "options" to poll.options, "multi" to poll.multi),
            ))
            if (!ok) {
                pendingAcks.remove(clientId)?.third?.cancel()
                markFailed(convo, optimistic.id)
            }
            return
        }

        if (text.isNotEmpty() && isEncrypted(convo) && ::appContext.isInitialized) {
            scope.launch {
                val recipientIds = when (convo) {
                    is Convo.Dm -> listOf(me.id, convo.peerId)
                    is Convo.GroupChat -> listOf(me.id) + (_groups.value.firstOrNull { it.id == convo.groupId }?.members?.map { it.id } ?: emptyList())
                }
                // Re-checked every send (like web): a recipient with no device
                // key would otherwise be silently left out of the message.
                val missing = Crypto.usersMissingKeys(recipientIds.filter { it != me.id }.distinct())
                // Someone here has never signed in on any device, so there's no
                // key to encrypt for. With encryption on only by default, send it
                // unencrypted and say so; if it was turned on by hand, don't.
                if (missing.isNotEmpty() && !e2ePrefsHas(convo)) {
                    _sendError.value = if (missing.size == 1) "Sent without end-to-end encryption: the other person hasn't signed in on any device yet"
                        else "Sent without end-to-end encryption: ${missing.size} people haven't signed in on any device yet"
                    val ok = SessionManager.ws.send("message:send", mapOf(
                        "client_id" to clientId,
                        "recipient_id" to (convo as? Convo.Dm)?.peerId,
                        "group_id" to (convo as? Convo.GroupChat)?.groupId,
                        "file_id" to fileId,
                        "reply_to_id" to replyToId,
                        "mentions" to mentionIds(text),
                        "thread_root_id" to threadRootId,
                        "content" to text,
                    ))
                    if (!ok) {
                        pendingAcks.remove(clientId)?.third?.cancel()
                        markFailed(convo, optimistic.id)
                    }
                    return@launch
                }
                if (missing.isNotEmpty()) {
                    pendingAcks.remove(clientId)?.third?.cancel()
                    markFailed(convo, optimistic.id)
                    _sendError.value = if (missing.size == 1) "Not sent: a recipient has not set up encryption on any device yet"
                        else "Not sent: ${missing.size} recipients have not set up encryption yet"
                    return@launch
                }
                val enc = runCatching { Crypto.encryptForRecipients(appContext, text, recipientIds) }.getOrNull()
                if (enc == null) {
                    pendingAcks.remove(clientId)?.third?.cancel()
                    markFailed(convo, optimistic.id)
                    _sendError.value = "Couldn't encrypt the message"
                    return@launch
                }
                val ok = SessionManager.ws.send("message:send", mapOf(
                    "client_id" to clientId,
                    "recipient_id" to (convo as? Convo.Dm)?.peerId,
                    "group_id" to (convo as? Convo.GroupChat)?.groupId,
                    "file_id" to fileId,
                    "reply_to_id" to replyToId,
                        "mentions" to mentionIds(text),
                        "thread_root_id" to threadRootId,
                    "content" to enc.ciphertext,
                    "encrypted" to true,
                    "enc_iv" to enc.iv,
                    "enc_keys" to enc.encKeys,
                ))
                if (!ok) {
                    pendingAcks.remove(clientId)?.third?.cancel()
                    markFailed(convo, optimistic.id)
                }
            }
            return
        }

        val ok = SessionManager.ws.send("message:send", mapOf(
            "client_id" to clientId,
            "recipient_id" to (convo as? Convo.Dm)?.peerId,
            "group_id" to (convo as? Convo.GroupChat)?.groupId,
            "file_id" to fileId,
            "reply_to_id" to replyToId,
                        "mentions" to mentionIds(text),
                        "thread_root_id" to threadRootId,
            "content" to text,
        ))
        if (!ok) {
            pendingAcks.remove(clientId)?.third?.cancel()
            markFailed(convo, optimistic.id)
        }
    }

    private fun markFailed(convo: Convo, optimisticId: Long) {
        val list = (_messages.value[convo.key] ?: emptyList()).map { if (it.id == optimisticId) it.copy(pending = false, failed = true) else it }
        _messages.value = _messages.value.toMutableMap().apply { put(convo.key, list) }
    }

    fun retryMessage(convo: Convo, msg: Message) {
        _messages.value = _messages.value.toMutableMap().apply {
            put(convo.key, (get(convo.key) ?: emptyList()).filter { it.id != msg.id })
        }
        sendMessage(convo, msg.decryptedContent ?: msg.content, msg.file_id, msg.reply_to_id, msg.thread_root_id)
    }

    // Each of these only applies its optimistic local mutation if the WS send
    // actually went out; otherwise (e.g. mid-reconnect) the local state would
    // silently diverge from the server's until the next full resync.
    fun deleteMessage(msg: Message) {
        if (!SessionManager.ws.send("message:delete", mapOf("id" to msg.id))) return
        mutateEverywhere(msg.id) { it.copy(deleted_at = "now", content = "") }
    }

    fun editMessage(msg: Message, content: String) {
        if (msg.is_encrypted) return // the server can't re-wrap keys; delete and resend instead
        val trimmed = content.trim()
        if (trimmed.isEmpty() || trimmed == (msg.decryptedContent ?: msg.content)) return
        if (!SessionManager.ws.send("message:edit", mapOf("id" to msg.id, "content" to trimmed))) return
        mutateEverywhere(msg.id) { it.copy(content = trimmed, decryptedContent = trimmed, edited_at = "now") }
    }

    fun reactToMessage(msg: Message, emoji: String) {
        val me = SessionManager.me.value ?: return
        if (!SessionManager.ws.send("message:react", mapOf("id" to msg.id, "emoji" to emoji))) return
        val already = (msg.reactions ?: emptyList()).any { it.user_id == me.id && it.emoji == emoji }
        mutateEverywhere(msg.id) { m ->
            m.copy(reactions = if (already) (m.reactions ?: emptyList()).filterNot { it.user_id == me.id && it.emoji == emoji }
            else (m.reactions ?: emptyList()) + com.videocall.mobile.net.MessageReaction(msg.id, me.id, emoji))
        }
    }

    fun pinMessage(msg: Message, pinned: Boolean) {
        if (!SessionManager.ws.send("message:pin", mapOf("id" to msg.id, "pinned" to pinned))) return
        mutateEverywhere(msg.id) { it.copy(pinned_at = if (pinned) "now" else null) }
    }

    suspend fun fetchSaved() {
        _savedIds.value = runCatching { SessionManager.api.savedMessages() }.getOrDefault(emptyList()).map { it.id }.toSet()
    }

    suspend fun toggleSave(msg: Message) {
        val already = _savedIds.value.contains(msg.id)
        runCatching {
            if (already) SessionManager.api.unsaveMessage(msg.id) else SessionManager.api.saveMessage(msg.id)
        }.onSuccess {
            _savedIds.value = if (already) _savedIds.value - msg.id else _savedIds.value + msg.id
        }
    }

    private var lastTypingSent = 0L
    fun sendTyping(convo: Convo) {
        val now = System.currentTimeMillis()
        if (now - lastTypingSent < 2500) return
        lastTypingSent = now
        SessionManager.ws.send("message:typing", mapOf(
            "recipient_id" to (convo as? Convo.Dm)?.peerId,
            "group_id" to (convo as? Convo.GroupChat)?.groupId,
        ))
    }

    fun markRead(convo: Convo) {
        _unread.value = _unread.value.toMutableMap().apply { remove(convo.key) }
        SessionManager.ws.send("message:read", mapOf(
            "peer_id" to (convo as? Convo.Dm)?.peerId,
            "group_id" to (convo as? Convo.GroupChat)?.groupId,
        ))
    }

    // ---- threads, polls, blocking ---------------------------------------

    class PollDraft(val options: List<String>, val multi: Boolean)

    private val _blocked = MutableStateFlow<Set<Long>>(emptySet())
    val blocked: StateFlow<Set<Long>> = _blocked

    suspend fun loadBlocked() {
        _blocked.value = runCatching { SessionManager.api.blockedUsers() }.getOrNull()?.toSet() ?: return
    }

    suspend fun setBlocked(userId: Long, on: Boolean) {
        if (on) SessionManager.api.blockUser(userId) else SessionManager.api.unblockUser(userId)
        loadBlocked()
    }

    private fun bumpThread(convo: Convo, msg: Message) {
        val root = msg.thread_root_id ?: return
        val list = (_messages.value[convo.key] ?: return).map { if (it.id == root) it.copy(thread_count = it.thread_count + 1) else it }
        _messages.value = _messages.value.toMutableMap().apply { put(convo.key, list) }
    }

    /** Loads a thread's replies into the conversation so the thread view (and unread logic) can see them. */
    suspend fun loadThread(convo: Convo, rootId: Long) {
        val replies = runCatching { SessionManager.api.thread(rootId) }.getOrNull() ?: return
        if (replies.isEmpty()) return
        merge(convo, replies)
        decryptPending(convo, replies)
    }

    fun votePoll(pollId: Long, optionId: Long) {
        SessionManager.ws.send("poll:vote", mapOf("poll_id" to pollId, "option_id" to optionId))
    }

    fun closePoll(pollId: Long) {
        SessionManager.ws.send("poll:close", mapOf("poll_id" to pollId))
    }

    // ---- offline cache -------------------------------------------------

    @kotlinx.serialization.Serializable
    private data class DiskCache(val messages: Map<String, List<Message>> = emptyMap(), val groups: List<Group> = emptyList())

    private fun cacheFile(): File? {
        if (!::appContext.isInitialized) return null
        val uid = SessionManager.me.value?.id ?: return null
        return File(appContext.filesDir, "chat-cache-$uid.json")
    }

    private fun loadDiskCache() {
        val f = cacheFile() ?: return
        runCatching {
            if (!f.exists()) return
            val c = json.decodeFromString<DiskCache>(f.readText())
            if (_messages.value.isEmpty()) _messages.value = c.messages
            if (_groups.value.isEmpty()) _groups.value = c.groups
            redecryptAll()
        }
    }

    private var cacheWriterStarted = false

    // Saves the latest messages of every chat two seconds after things settle,
    // so the app opens with recent history even with no connection.
    private fun startCacheWriter() {
        if (cacheWriterStarted) return
        cacheWriterStarted = true
        scope.launch {
            combine(_messages, _groups) { m, g -> m to g }.collectLatest { (m, g) ->
                kotlinx.coroutines.delay(2000)
                val f = cacheFile() ?: return@collectLatest
                val slim = m.mapValues { (_, list) ->
                    list.filter { it.id > 0 }.takeLast(50).map { it.copy(decryptedContent = null, clientId = null, pending = false, failed = false) }
                }.filterValues { it.isNotEmpty() }
                withContext(Dispatchers.IO) {
                    runCatching { f.writeText(json.encodeToString(DiskCache.serializer(), DiskCache(slim, g))) }
                }
            }
        }
    }

    private fun deleteDiskCache() {
        if (!::appContext.isInitialized) return
        appContext.filesDir.listFiles { f -> f.name.startsWith("chat-cache-") }?.forEach { it.delete() }
    }

    private fun convoOf(key: String): Convo? = when {
        key.startsWith("dm:") -> key.removePrefix("dm:").toLongOrNull()?.let { Convo.Dm(it) }
        key.startsWith("g:") -> key.removePrefix("g:").toLongOrNull()?.let { Convo.GroupChat(it) }
        else -> null
    }

    private val resent = mutableSetOf<String>()

    /** After a reconnect, sends once more anything that failed while offline. */
    private fun resendFailed() {
        for ((key, list) in _messages.value) {
            val convo = convoOf(key) ?: continue
            for (m in list) {
                val id = m.clientId ?: continue
                if (m.failed && m.id < 0 && resent.add(id)) retryMessage(convo, m)
            }
        }
    }

    // ---- export / local search of encrypted chats -----------------------

    private suspend fun plainText(m: Message): String {
        if (m.deleted_at != null) return "(deleted)"
        if (!m.is_encrypted) return m.content
        return runCatching { Crypto.decryptMessageContent(appContext, m.id, m.is_encrypted, m.content, m.enc_iv, m.enc_keys) }.getOrNull()
            ?: "(can't decrypt on this device)"
    }

    /** Whole history as a readable transcript, decrypted on this device. */
    suspend fun exportTranscript(convo: Convo, titleOf: (Long) -> String): File = withContext(Dispatchers.IO) {
        val all = LinkedHashMap<Long, Message>()
        var before: Long? = null
        for (page in 0 until 200) {
            val batch = fetchPage(convo, before) ?: throw java.io.IOException("Couldn't load the whole history")
            batch.forEach { all[it.id] = it }
            if (batch.size < 50) break
            before = batch.minOf { it.id }
        }
        val zone = java.time.ZoneId.systemDefault()
        val fmt = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
        val sb = StringBuilder()
        for (m in all.values.sortedWith(::messageOrder)) {
            val whenText = runCatching { fmt.format(java.time.Instant.parse(m.sent_at).atZone(zone)) }.getOrDefault(m.sent_at)
            val who = m.sender?.display_name ?: titleOf(m.sender_id)
            sb.append('[').append(whenText).append("] ").append(who).append(": ").append(plainText(m))
            m.file?.let { sb.append("  [file: ").append(it.name).append(']') }
            sb.append('\n')
        }
        val dir = File(appContext.cacheDir, "downloads").apply { mkdirs() }
        File(dir, "chat-${convo.key.replace(':', '-')}.txt").also { it.writeText(sb.toString()) }
    }

    /** Searches the latest page of each known chat, decrypting on this device. */
    suspend fun searchEncrypted(query: String): List<Message> = withContext(Dispatchers.IO) {
        val q = query.lowercase()
        val hits = mutableListOf<Message>()
        for (key in _messages.value.keys.take(40)) {
            val convo = convoOf(key) ?: continue
            val page = fetchPage(convo, null) ?: continue
            for (m in page) {
                if (!m.is_encrypted || m.deleted_at != null) continue
                val text = plainText(m)
                if (text.lowercase().contains(q)) hits += m.copy(is_encrypted = false, content = text)
            }
        }
        hits.sortedByDescending { it.sent_at }
    }
}
