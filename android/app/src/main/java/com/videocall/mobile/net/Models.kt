package com.videocall.mobile.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Mirrors web/src/lib/types.ts — kept field-for-field so the JSON the server
// already emits for the web client decodes here without any translation layer.

@Serializable
data class User(
    // Defaulted rather than required: PATCH /api/users/me returns either the
    // updated User or, when a password change forces other sessions to log
    // out, a bare {"status": "..."} — decoding that into a zero-value User
    // (caller checks id != 0L) beats throwing on an otherwise-successful call.
    val id: Long = 0,
    val username: String = "",
    val display_name: String = "",
    val role: String = "user",
    val avatar_file_id: Long? = null,
    val email: String? = null,
    val disabled: Boolean = false,
    // Removed by an admin; shown as "Deleted user" and can't be re-enabled.
    val deleted: Boolean = false,
    val created_at: String = "",
    val oidc_linked: Boolean = false,
    val status_text: String = "",
    val must_change_password: Boolean = false,
    val totp_enabled: Boolean = false,
    val status: String = "offline",
    // Present on /api/me, /api/login and PATCH /api/users/me — the account's
    // saved look, shared with the web client (see ui/theme/Theme.kt).
    val preferences: UserPreferences? = null,
)

/** Server-stored UI preferences — same values the web client offers. */
@Serializable
data class UserPreferences(
    val theme: String = "dark",        // dark | light | midnight | sunset | forest | cyberpunk
    val accent_color: String = "blue", // blue | purple | emerald | rose | amber | cyan
    val radius: String = "rounded",    // rounded | compact | pill
)

/** GET /api/conversations/recent: the latest message of each DM and group. */
@Serializable
data class RecentConversations(
    val dms: List<Message>? = null,
    val groups: List<Message>? = null,
)

@Serializable
data class UserBrief(
    val id: Long,
    val display_name: String,
    val username: String,
    val avatar_file_id: Long? = null,
)

@Serializable
data class GroupMember(
    val id: Long,
    val display_name: String,
    val username: String,
    val avatar_file_id: Long? = null,
    val role: String = "member",
)

@Serializable
data class FileBrief(val id: Long, val name: String, val mime: String, val size: Long)

@Serializable
data class MessageReaction(val message_id: Long, val user_id: Long, val emoji: String)

@Serializable
data class MessagePreview(
    val id: Long,
    val content: String,
    val has_file: Boolean = false,
    val deleted: Boolean = false,
    val is_encrypted: Boolean = false,
    val sender: UserBrief? = null,
)

@Serializable
data class Message(
    val id: Long,
    val sender_id: Long,
    val recipient_id: Long? = null,
    val group_id: Long? = null,
    val file_id: Long? = null,
    val content: String,
    val sent_at: String = "",
    val delivered_at: String? = null,
    val read_at: String? = null,
    val deleted_at: String? = null,
    val edited_at: String? = null,
    val reply_to_id: Long? = null,
    val pinned_at: String? = null,
    val is_encrypted: Boolean = false,
    val enc_iv: String? = null,
    val enc_keys: String? = null,
    val mentions: List<Long>? = null,
    // Set on a reply that lives inside another message's thread.
    val thread_root_id: Long? = null,
    // On a thread's first message: how many replies it has.
    val thread_count: Int = 0,
    val poll: Poll? = null,
    val reply_to: MessagePreview? = null,
    val reactions: List<MessageReaction>? = null,
    val sender: UserBrief? = null,
    val file: FileBrief? = null,
    // client-only bookkeeping, never sent by the server
    val clientId: String? = null,
    val pending: Boolean = false,
    val failed: Boolean = false,
    val decryptedContent: String? = null,
)

@Serializable
data class Group(
    val id: Long,
    val name: String,
    val topic: String = "",
    val created_by: Long = 0,
    val created_at: String = "",
    val avatar_file_id: Long? = null,
    val members: List<GroupMember> = emptyList(),
    // Public groups are channels anyone can find and join.
    val public: Boolean = false,
    val member_count: Int = 0,
)

@Serializable
data class PollOption(val id: Long, val text: String, val votes: List<Long> = emptyList())

@Serializable
data class Poll(
    val id: Long,
    val question: String,
    val multi: Boolean = false,
    val closed: Boolean = false,
    val options: List<PollOption> = emptyList(),
)

@Serializable
data class CallParticipant(
    val user_id: Long,
    val joined_at: String? = null,
    val left_at: String? = null,
    val missed: Boolean = false,
    val user: UserBrief? = null,
)

@Serializable
data class Call(
    val id: Long,
    val room_id: String,
    val initiator_id: Long,
    val is_conference: Boolean,
    val started_at: String,
    val ended_at: String? = null,
    val initiator: UserBrief? = null,
    val participants: List<CallParticipant>? = null,
)

@Serializable
data class ParticipantInfo(
    val user_id: Long,
    val display_name: String,
    val avatar_file_id: Long? = null,
    val muted: Boolean = false,
    val video_on: Boolean = false,
    val screen: Boolean = false,
    val host: Boolean = false,
    val locked: Boolean = false,
    val can_present: Boolean = false,
)

@Serializable
data class IceServer(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

@Serializable
data class IceServersResponse(val iceServers: List<IceServer> = emptyList())

@Serializable
data class AdminStorage(val db_bytes: Long = 0, val files_bytes: Long = 0, val total_bytes: Long = 0)

@Serializable
data class AdminStats(
    val version: String = "",
    val uptime_hours: Double = 0.0,
    val users: Int = 0,
    val online: Int = 0,
    val active_calls: Int = 0,
    val db_driver: String = "",
    val storage: AdminStorage = AdminStorage(),
)

@Serializable
data class ApiOk(val ok: Boolean = false)

/** The account's password-protected encryption key backup (see Crypto). */
@Serializable
data class KeyBackupStatus(
    val exists: Boolean = false,
    val data: kotlinx.serialization.json.JsonObject? = null,
    val updated_at: String? = null,
)

@Serializable
data class UploadResult(val id: Long, val name: String, val mime: String, val size: Long)

@Serializable
data class PrivateRoom(
    val id: String,
    val name: String,
    val owner: UserBrief? = null,
    val require_passcode: Boolean = false,
    val require_approval: Boolean = false,
    val is_owner: Boolean = false,
    val created_at: String = "",
    // Start time of a scheduled meeting (ISO-8601 UTC); empty for an instant room.
    val scheduled_at: String = "",
)

@Serializable
data class DeviceKey(val user_id: Long, val device_id: String, val public_key_jwk: String)

@Serializable
data class SettingView(
    val key: String,
    val label: String,
    val description: String,
    val kind: String,
    val group: String,
    val editable: Boolean,
    val value: String,
    val source: String,
)

@Serializable
data class AuditEntry(
    val id: Long,
    val actor_id: Long? = null,
    val actor_name: String = "",
    val action: String = "",
    val target_type: String = "",
    val target_id: Long? = null,
    val detail: String = "",
    val ip: String = "",
    val created_at: String = "",
)

@Serializable
data class OidcConfig(val enabled: Boolean = false, val button_label: String? = null)

/** One signed-in device (GET /api/users/me/sessions). */
@Serializable
data class SessionInfo(
    val id: String,
    val user_agent: String = "",
    val ip: String = "",
    val created_at: String = "",
    val last_seen: String = "",
    val current: Boolean = false,
)

/** Per-conversation mute/archive (kind is "dm" or "group"). */
@Serializable
data class ConvoPref(val kind: String, val target_id: Long, val muted: Boolean = false, val archived: Boolean = false)

@Serializable
data class TotpSetup(val secret: String, val uri: String)
