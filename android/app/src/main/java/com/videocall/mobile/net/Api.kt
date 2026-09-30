package com.videocall.mobile.net

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : Exception(message)

val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

/**
 * Thin REST client mirroring web/src/lib/api.ts: same endpoints, same
 * cookie-session + double-submit CSRF header scheme, same "401 means the
 * session died" signal. One client per server URL for the whole app.
 */
class Api(private val context: Context, val baseUrl: String) {
    val cookieJar = PersistentCookieJar(context)
    var onUnauthorized: (() -> Unit)? = null

    val client: OkHttpClient = run {
        val builder = OkHttpClient.Builder()
            .cookieJar(cookieJar)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)

        builder.build()
    }

    private val host: String get() = baseUrl.toHttpUrlOrNull()?.host ?: ""

    private fun csrfToken(): String? = cookieJar.cookieValue(host, "vc_csrf")

    private suspend inline fun <reified T> exec(
        path: String,
        method: String = "GET",
        body: okhttp3.RequestBody? = null,
        expectedUnauthenticated: Boolean = false,
    ): T = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(baseUrl + path)
        if (method != "GET" && method != "HEAD") {
            csrfToken()?.let { builder.addHeader("X-CSRF-Token", it) }
        }
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> if (body != null) builder.delete(body) else builder.delete()
            else -> builder.method(method, body ?: "".toRequestBody(null))
        }
        val res: Response = client.newCall(builder.build()).execute()
        res.use {
            val text = it.body?.string() ?: ""
            if (!it.isSuccessful) {
                if (it.code == 401 && !expectedUnauthenticated) onUnauthorized?.invoke()
                val msg = runCatching { json.decodeFromString<Map<String, String>>(text)["error"] }.getOrNull()
                throw ApiException(it.code, msg ?: it.message)
            }
            if (T::class == Unit::class) return@withContext Unit as T
            if (text.isBlank()) return@withContext json.decodeFromString<T>("null")
            return@withContext json.decodeFromString(text)
        }
    }

    private fun jsonBody(obj: Map<String, Any?>): okhttp3.RequestBody {
        val clean = obj.filterValues { it != null }
        return json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), buildJsonObj(clean))
            .toRequestBody("application/json".toMediaType())
    }

    private fun buildJsonObj(map: Map<String, Any?>): kotlinx.serialization.json.JsonObject {
        val entries = map.mapValues { (_, v) -> anyToJson(v) }
        return kotlinx.serialization.json.JsonObject(entries)
    }

    private fun anyToJson(v: Any?): kotlinx.serialization.json.JsonElement = when (v) {
        null -> kotlinx.serialization.json.JsonNull
        is kotlinx.serialization.json.JsonElement -> v
        is String -> kotlinx.serialization.json.JsonPrimitive(v)
        is Boolean -> kotlinx.serialization.json.JsonPrimitive(v)
        is Int -> kotlinx.serialization.json.JsonPrimitive(v)
        is Long -> kotlinx.serialization.json.JsonPrimitive(v)
        is Double -> kotlinx.serialization.json.JsonPrimitive(v)
        is List<*> -> kotlinx.serialization.json.JsonArray(v.map { anyToJson(it) })
        else -> kotlinx.serialization.json.JsonPrimitive(v.toString())
    }

    // ---- auth ----
    suspend fun login(username: String, password: String, totpCode: String? = null): User =
        exec("/api/login", "POST", jsonBody(mapOf("username" to username, "password" to password, "totp_code" to totpCode)), expectedUnauthenticated = true)

    suspend fun sessions(): List<SessionInfo> = exec<List<SessionInfo>?>("/api/users/me/sessions") ?: emptyList()
    suspend fun revokeSession(id: String): ApiOk = exec("/api/users/me/sessions/${java.net.URLEncoder.encode(id, "UTF-8")}", "DELETE")
    suspend fun revokeOtherSessions(): ApiOk = exec("/api/users/me/sessions/revoke-others", "POST")
    suspend fun totpSetup(): TotpSetup = exec("/api/users/me/totp/setup", "POST")
    suspend fun totpEnable(secret: String, code: String): ApiOk = exec("/api/users/me/totp/enable", "POST", jsonBody(mapOf("secret" to secret, "code" to code)))
    suspend fun totpDisable(password: String): ApiOk = exec("/api/users/me/totp/disable", "POST", jsonBody(mapOf("password" to password)))
    suspend fun setStatusText(text: String): Map<String, String> = exec("/api/users/me/status-text", "PUT", jsonBody(mapOf("text" to text)))
    suspend fun unreadSummary(): Map<String, Int> = exec("/api/unread")
    suspend fun convoPrefs(): List<ConvoPref> = exec<List<ConvoPref>?>("/api/conversations/prefs") ?: emptyList()
    suspend fun setConvoPref(p: ConvoPref): ConvoPref =
        exec("/api/conversations/prefs", "PUT", jsonBody(mapOf("kind" to p.kind, "target_id" to p.target_id, "muted" to p.muted, "archived" to p.archived)))

    suspend fun logout(): ApiOk = exec("/api/logout", "POST")
    suspend fun me(): User = exec("/api/me", expectedUnauthenticated = true)

    suspend fun preferences(): UserPreferences = exec("/api/users/me/preferences")
    suspend fun updatePreferences(prefs: UserPreferences): UserPreferences =
        exec("/api/users/me/preferences", "PUT", jsonBody(mapOf("theme" to prefs.theme, "accent_color" to prefs.accent_color, "radius" to prefs.radius)))

    // ---- directory ----
    suspend fun users(): List<User> = exec<List<User>?>("/api/users") ?: emptyList()

    suspend fun updateSelf(displayName: String? = null, avatarFileId: Long? = null, email: String? = null, currentPassword: String? = null, newPassword: String? = null): User =
        exec("/api/users/me", "PATCH", jsonBody(mapOf(
            "display_name" to displayName, "avatar_file_id" to avatarFileId, "email" to email,
            "current_password" to currentPassword, "new_password" to newPassword,
        )))

    // ---- OIDC / password reset ----
    suspend fun oidcConfig(): OidcConfig = exec("/api/oidc/config", expectedUnauthenticated = true)
    fun oidcLoginUrl(): String = "$baseUrl/api/oidc/login"
    suspend fun oidcUnlink(): ApiOk = exec("/api/oidc/link", "DELETE")
    suspend fun adminOidcUnlink(userId: Long): ApiOk = exec("/api/users/$userId/oidc-link", "DELETE")

    suspend fun passwordResetEnabled(): Map<String, Boolean> = exec("/api/password-reset/enabled", expectedUnauthenticated = true)
    suspend fun requestPasswordReset(email: String): Map<String, String> =
        exec("/api/password-reset/request", "POST", jsonBody(mapOf("email" to email)), expectedUnauthenticated = true)
    suspend fun confirmPasswordReset(token: String, newPassword: String): ApiOk =
        exec("/api/password-reset/confirm", "POST", jsonBody(mapOf("token" to token, "new_password" to newPassword)), expectedUnauthenticated = true)

    // ---- device keys (E2E chat encryption) ----
    suspend fun registerDeviceKey(deviceId: String, publicKeyJwk: String): ApiOk =
        exec("/api/devices/keys", "PUT", jsonBody(mapOf("device_id" to deviceId, "public_key_jwk" to publicKeyJwk)))
    suspend fun keyBackup(): KeyBackupStatus = exec("/api/users/me/key-backup")
    suspend fun saveKeyBackup(data: kotlinx.serialization.json.JsonObject, publicKeyJwk: String): ApiOk =
        exec("/api/users/me/key-backup", "PUT", jsonBody(mapOf("data" to data, "public_key_jwk" to publicKeyJwk)))
    suspend fun deleteKeyBackup(): ApiOk = exec("/api/users/me/key-backup", "DELETE")
    suspend fun deviceKeys(userIds: List<Long>): List<DeviceKey> =
        exec<List<DeviceKey>?>("/api/devices/keys?user_ids=${userIds.joinToString(",")}") ?: emptyList()

    // ---- chats ----
    suspend fun directMessages(peerId: Long, before: Long? = null): List<Message> =
        exec<List<Message>?>("/api/messages/$peerId" + (before?.let { "?before=$it&limit=50" } ?: "")) ?: emptyList()

    suspend fun recentConversations(): RecentConversations = exec("/api/conversations/recent")

    suspend fun groups(): List<Group> = exec<List<Group>?>("/api/groups") ?: emptyList()

    suspend fun createGroup(name: String, memberIds: List<Long>, public: Boolean = false): Group =
        exec("/api/groups", "POST", jsonBody(mapOf("name" to name, "member_ids" to memberIds, "public" to public)))

    suspend fun publicGroups(): List<Group> = exec<List<Group>?>("/api/groups/public") ?: emptyList()
    suspend fun joinGroup(groupId: Long): Group = exec("/api/groups/$groupId/join", "POST")
    suspend fun setGroupPublic(groupId: Long, public: Boolean): Group =
        exec("/api/groups/$groupId", "PATCH", jsonBody(mapOf("public" to public)))
    suspend fun thread(rootId: Long): List<Message> = exec<List<Message>?>("/api/threads/$rootId") ?: emptyList()
    suspend fun blockedUsers(): List<Long> = exec<List<Long>?>("/api/users/me/blocked") ?: emptyList()
    suspend fun blockUser(id: Long): ApiOk = exec("/api/users/$id/block", "POST")
    suspend fun unblockUser(id: Long): ApiOk = exec("/api/users/$id/block", "DELETE")

    suspend fun groupMessages(groupId: Long, before: Long? = null): List<Message> =
        exec<List<Message>?>("/api/groups/$groupId/messages" + (before?.let { "?before=$it&limit=50" } ?: "")) ?: emptyList()

    suspend fun addGroupMembers(groupId: Long, memberIds: List<Long>): Group =
        exec("/api/groups/$groupId/members", "POST", jsonBody(mapOf("member_ids" to memberIds)))

    suspend fun removeGroupMember(groupId: Long, userId: Long): ApiOk =
        exec("/api/groups/$groupId/members/$userId", "DELETE")

    suspend fun renameGroup(groupId: Long, name: String): Group =
        exec("/api/groups/$groupId", "PATCH", jsonBody(mapOf("name" to name)))

    suspend fun updateGroup(groupId: Long, name: String? = null, topic: String? = null, avatarFileId: Long? = null): Group =
        exec("/api/groups/$groupId", "PATCH", jsonBody(mapOf("name" to name, "topic" to topic, "avatar_file_id" to avatarFileId)))

    suspend fun setGroupMemberRole(groupId: Long, userId: Long, role: String): Group =
        exec("/api/groups/$groupId/members/$userId", "PATCH", jsonBody(mapOf("role" to role)))

    suspend fun groupReadState(groupId: Long): Map<String, Long> = exec("/api/groups/$groupId/read-state")

    suspend fun deleteGroup(groupId: Long): ApiOk = exec("/api/groups/$groupId", "DELETE")

    // ---- search / pinned / saved / export ----
    suspend fun pinnedMessages(groupId: Long? = null, peerId: Long? = null): List<Message> =
        exec<List<Message>?>("/api/pinned?" + (groupId?.let { "group_id=$it" } ?: "peer_id=$peerId")) ?: emptyList()

    suspend fun searchMessages(q: String? = null, senderId: Long? = null, since: String? = null, until: String? = null, hasFile: Boolean? = null, limit: Int? = null): List<Message> {
        val params = mutableListOf<String>()
        q?.let { params += "q=${java.net.URLEncoder.encode(it, "UTF-8")}" }
        senderId?.let { params += "sender_id=$it" }
        since?.let { params += "since=$it" }
        until?.let { params += "until=$it" }
        if (hasFile == true) params += "has_file=true"
        limit?.let { params += "limit=$it" }
        return exec<List<Message>?>("/api/search?" + params.joinToString("&")) ?: emptyList()
    }

    suspend fun savedMessages(): List<Message> = exec<List<Message>?>("/api/saved") ?: emptyList()
    suspend fun saveMessage(id: Long): ApiOk = exec("/api/messages/$id/save", "PUT")
    suspend fun unsaveMessage(id: Long): ApiOk = exec("/api/messages/$id/save", "DELETE")
    fun exportUrl(groupId: Long? = null, peerId: Long? = null): String =
        "$baseUrl/api/export?" + (groupId?.let { "group_id=$it" } ?: "peer_id=$peerId")

    // ---- private rooms ----
    suspend fun createRoom(name: String, passcode: String? = null, requireApproval: Boolean = false, invitedUserIds: List<Long> = emptyList(), scheduledAt: String? = null): PrivateRoom =
        exec("/api/rooms", "POST", jsonBody(mapOf("name" to name, "passcode" to passcode, "require_approval" to requireApproval, "invited_user_ids" to invitedUserIds, "scheduled_at" to scheduledAt)))
    suspend fun myRooms(): List<PrivateRoom> = exec<List<PrivateRoom>?>("/api/rooms") ?: emptyList()
    suspend fun getRoom(id: String): PrivateRoom = exec("/api/rooms/${java.net.URLEncoder.encode(id, "UTF-8")}")
    suspend fun deleteRoom(id: String): ApiOk = exec("/api/rooms/${java.net.URLEncoder.encode(id, "UTF-8")}", "DELETE")

    // ---- calls ----
    suspend fun calls(limit: Int = 50): List<Call> = exec<List<Call>?>("/api/calls?limit=$limit") ?: emptyList()
    suspend fun iceServers(): IceServersResponse = exec("/api/ice")

    // ---- files ----
    /** Uploads a file; [onProgress] gets 0..1 as the bytes go out. */
    suspend fun uploadFile(file: File, mime: String, onProgress: ((Float) -> Unit)? = null): UploadResult = withContext(Dispatchers.IO) {
        val fileBody = if (onProgress == null) okhttp3.RequestBody.create(mime.toMediaType(), file)
        else ProgressFileBody(file, mime.toMediaType(), onProgress)
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", file.name, fileBody)
            .build()
        val req = Request.Builder().url("$baseUrl/api/files").post(body)
        csrfToken()?.let { req.addHeader("X-CSRF-Token", it) }
        client.newCall(req.build()).execute().use {
            val text = it.body?.string() ?: ""
            if (!it.isSuccessful) {
                // Surface the server's reason ("files of type .exe are not allowed",
                // "storage quota exceeded") rather than a bare HTTP status line.
                val msg = runCatching { json.decodeFromString<Map<String, String>>(text)["error"] }.getOrNull()
                throw ApiException(it.code, msg ?: it.message)
            }
            json.decodeFromString(text)
        }
    }

    fun fileUrl(id: Long) = "$baseUrl/api/files/$id"

    /** Downloads any authenticated GET (attachments, /api/export) to a local file. */
    suspend fun downloadToFile(url: String, destFile: File): File = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url).build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, res.message)
            destFile.outputStream().use { out -> res.body?.byteStream()?.copyTo(out) }
        }
        destFile
    }

    // ---- admin ----
    suspend fun adminStats(): AdminStats = exec("/api/admin/stats")
    suspend fun adminGroups(): List<Group> = exec<List<Group>?>("/api/admin/groups") ?: emptyList()
    suspend fun createUser(username: String, displayName: String, password: String, role: String, email: String? = null): User =
        exec("/api/users", "POST", jsonBody(mapOf("username" to username, "display_name" to displayName, "password" to password, "role" to role, "email" to email)))
    suspend fun updateUser(id: Long, displayName: String? = null, role: String? = null, disabled: Boolean? = null, password: String? = null, email: String? = null): User =
        exec("/api/users/$id", "PATCH", jsonBody(mapOf("display_name" to displayName, "role" to role, "disabled" to disabled, "password" to password, "email" to email)))
    /** permanent = false keeps their messages as "Deleted user"; true erases everything. */
    suspend fun deleteUser(id: Long, permanent: Boolean = false): ApiOk =
        exec("/api/users/$id" + if (permanent) "?permanent=true" else "", "DELETE")
    suspend fun signOutUser(id: Long): ApiOk = exec("/api/users/$id/sign-out", "POST")
    suspend fun listSettings(): List<SettingView> = exec("/api/admin/settings")
    suspend fun updateSetting(key: String, value: String): ApiOk =
        exec("/api/admin/settings/${java.net.URLEncoder.encode(key, "UTF-8")}", "PUT", jsonBody(mapOf("value" to value)))
    suspend fun resetSetting(key: String): ApiOk = exec("/api/admin/settings/${java.net.URLEncoder.encode(key, "UTF-8")}", "DELETE")
    suspend fun auditLog(before: Long? = null): List<AuditEntry> =
        exec<List<AuditEntry>?>("/api/admin/audit" + (before?.let { "?before=$it" } ?: "")) ?: emptyList()
}

/** A file request body that reports how much has been sent. */
private class ProgressFileBody(
    private val file: File,
    private val type: okhttp3.MediaType,
    private val onProgress: (Float) -> Unit,
) : okhttp3.RequestBody() {
    override fun contentType() = type
    override fun contentLength() = file.length()
    override fun writeTo(sink: okio.BufferedSink) {
        val total = contentLength().coerceAtLeast(1)
        var sent = 0L
        file.inputStream().use { input ->
            val buf = ByteArray(16 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                sink.write(buf, 0, n)
                sent += n
                onProgress((sent.toFloat() / total).coerceAtMost(1f))
            }
        }
    }
}
