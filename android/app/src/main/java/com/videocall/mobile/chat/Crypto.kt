package com.videocall.mobile.chat

import android.content.Context
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.decodeFromJsonElement
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import com.videocall.mobile.net.DeviceKey
import com.videocall.mobile.net.Prefs
import com.videocall.mobile.session.SessionManager

/**
 * Client-side E2E chat encryption — a straight port of web/src/lib/crypto.ts
 * to the JVM: ECDH P-256 per-device keypair, AES-256-GCM content key per
 * message, the content key wrapped per-recipient-device via
 * ECDH(myPriv, theirPub). The server only ever sees public keys + ciphertext
 * (see api.registerDeviceKey/deviceKeys). No ratcheting/forward-secrecy
 * beyond "one fresh AES key per message", same as the web client.
 *
 * The private key is generated on-device and stored in EncryptedSharedPreferences
 * (an Android-Keystore-wrapped file) — it never leaves the device and is
 * never sent anywhere; only the public key is uploaded.
 */
object Crypto {
    private const val CURVE = "secp256r1" // NIST P-256, same curve WebCrypto calls "P-256"
    private const val PREFS = "vc_e2e_keys"
    // Keys are stored per account ("priv:<userId>"): on a shared phone the
    // next person to sign in must not inherit — and publish under their own
    // account — the previous user's private key. The unsuffixed names are the
    // old device-wide record, adopted once by its real owner (see below).
    private const val LEGACY_PRIV = "priv"
    private const val LEGACY_PUB = "pub_jwk"
    private fun privKey(userId: Long) = "priv:$userId"
    private fun pubKey(userId: Long) = "pub_jwk:$userId"

    @kotlinx.serialization.Serializable
    private data class WrappedKeyEntry(
        /** 2 = ciphertext and key wraps are bound to sender + conversation (AAD). */
        val v: Int = 0,
        val user_id: Long,
        val device_id: String,
        val wrapped_key: String,
        val wrap_iv: String,
        val sender_pub_jwk: JsonObject,
    )

    data class KeyPairBundle(val private: PrivateKey, val public: PublicKey, val publicJwk: JsonObject)

    private var cached: KeyPairBundle? = null
    private var cachedFor: Long? = null

    private fun prefs(context: Context) = EncryptedSharedPreferences.create(
        context,
        PREFS,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    private fun currentUserId(): Long =
        SessionManager.me.value?.id ?: throw IllegalStateException("E2E keys are not available before sign-in")

    private suspend fun getOrCreateKeyPair(context: Context): KeyPairBundle {
        val userId = currentUserId()
        if (cachedFor == userId) cached?.let { return it }
        val p = prefs(context)
        val kf = KeyFactory.getInstance("EC")
        if (!p.contains(privKey(userId))) adoptLegacyKeyPair(context, userId)
        val storedPriv = p.getString(privKey(userId), null)
        val storedPub = p.getString(pubKey(userId), null)
        val bundle = if (storedPriv != null && storedPub != null) {
            val priv = kf.generatePrivate(PKCS8EncodedKeySpec(Base64.decode(storedPriv, Base64.NO_WRAP)))
            val jwk = json.parseToJsonElement(storedPub) as JsonObject
            KeyPairBundle(priv, publicKeyFromJwk(jwk), jwk)
        } else {
            val gen = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec(CURVE)) }
            val pair = gen.generateKeyPair()
            val jwk = publicKeyToJwk(pair.public as java.security.interfaces.ECPublicKey)
            p.edit()
                .putString(privKey(userId), Base64.encodeToString(pair.private.encoded, Base64.NO_WRAP))
                .putString(pubKey(userId), jwk.toString())
                .apply()
            KeyPairBundle(pair.private, pair.public, jwk)
        }
        cached = bundle
        cachedFor = userId
        return bundle
    }

    /**
     * Moves the old device-wide keypair to [userId]'s record — but only if the
     * server has exactly that public key registered as this user's key for this
     * device, i.e. it really was theirs. Anyone else gets a fresh keypair.
     */
    private suspend fun adoptLegacyKeyPair(context: Context, userId: Long) {
        val p = prefs(context)
        val legacyPriv = p.getString(LEGACY_PRIV, null) ?: return
        val legacyPub = p.getString(LEGACY_PUB, null) ?: return
        val registered = runCatching { SessionManager.api.deviceKeys(listOf(userId)) }.getOrNull()
            ?.firstOrNull { it.device_id == Prefs.deviceId(context) } ?: return
        val mine = runCatching { json.parseToJsonElement(registered.public_key_jwk) as JsonObject }.getOrNull() ?: return
        val legacy = json.parseToJsonElement(legacyPub) as JsonObject
        if (mine["x"] != legacy["x"] || mine["y"] != legacy["y"]) return
        p.edit()
            .putString(privKey(userId), legacyPriv)
            .putString(pubKey(userId), legacyPub)
            .remove(LEGACY_PRIV)
            .remove(LEGACY_PUB)
            .apply()
    }

    /**
     * Publishes this device's public key for the signed-in account. Must run
     * after login (the endpoint needs a session) — calling it at app start
     * used to 401 silently on a fresh login, so nobody could encrypt to this
     * phone until the app was restarted.
     */
    suspend fun ensureDeviceRegistered(context: Context) {
        val bundle = runCatching { getOrCreateKeyPair(context) }.getOrNull() ?: return
        runCatching { SessionManager.api.registerDeviceKey(Prefs.deviceId(context), bundle.publicJwk.toString()) }
    }

    private fun fieldElement(n: BigInteger, size: Int = 32): ByteArray {
        val raw = n.toByteArray()
        val trimmed = if (raw.size > size) raw.copyOfRange(raw.size - size, raw.size) else raw
        if (trimmed.size == size) return trimmed
        val out = ByteArray(size)
        System.arraycopy(trimmed, 0, out, size - trimmed.size, trimmed.size)
        return out
    }

    private fun b64url(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun b64urlDecode(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun publicKeyToJwk(pub: java.security.interfaces.ECPublicKey): JsonObject = JsonObject(mapOf(
        "kty" to JsonPrimitive("EC"),
        "crv" to JsonPrimitive("P-256"),
        "x" to JsonPrimitive(b64url(fieldElement(pub.w.affineX))),
        "y" to JsonPrimitive(b64url(fieldElement(pub.w.affineY))),
        "ext" to JsonPrimitive(true),
    ))

    private val p256Params by lazy {
        val params = java.security.AlgorithmParameters.getInstance("EC")
        params.init(ECGenParameterSpec(CURVE))
        params.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
    }

    private fun publicKeyFromJwk(jwk: JsonObject): PublicKey {
        val x = BigInteger(1, b64urlDecode((jwk["x"] as JsonPrimitive).content))
        val y = BigInteger(1, b64urlDecode((jwk["y"] as JsonPrimitive).content))
        val point = ECPoint(x, y)
        val spec = ECPublicKeySpec(point, p256Params)
        return KeyFactory.getInstance("EC").generatePublic(spec)
    }

    private fun deriveWrapKey(myPriv: PrivateKey, peerPub: PublicKey): SecretKeySpec {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(myPriv)
        ka.doPhase(peerPub, true)
        val secret = ka.generateSecret() // 32 bytes for P-256, same bytes WebCrypto's ECDH deriveKey uses directly
        return SecretKeySpec(secret, "AES")
    }

    /** userIDs that do NOT have any registered device key yet — the gate for offering encryption. */
    suspend fun usersMissingKeys(userIds: List<Long>): List<Long> {
        val keys = runCatching { SessionManager.api.deviceKeys(userIds) }.getOrDefault(emptyList())
        val ready = keys.map { it.user_id }.toSet()
        return userIds.filterNot { it in ready }
    }

    data class EncryptedPayload(val ciphertext: String, val iv: String, val encKeys: String)

    /** "dm:<low>-<high>" or "g:<groupId>": where a message lives, bound into the encryption. */
    fun convoOf(senderId: Long, recipientId: Long?, groupId: Long?): String? = when {
        groupId != null -> "g:$groupId"
        recipientId != null -> "dm:${minOf(senderId, recipientId)}-${maxOf(senderId, recipientId)}"
        else -> null
    }

    private fun aadBytes(senderId: Long, convo: String) = "vc2|$senderId|$convo".toByteArray(Charsets.UTF_8)

    // ---- key pinning (trust on first use): same idea as the web client ----
    private const val PINS = "key_pins_v1"
    private fun fp(jwk: JsonObject) = "${(jwk["x"] as? JsonPrimitive)?.content}.${(jwk["y"] as? JsonPrimitive)?.content}"

    /** Returns user ids whose key for an already-known device changed; pins are updated so a retry goes through. */
    private fun checkPins(context: Context, keys: List<DeviceKey>): List<Long> {
        val p = prefs(context)
        val pins = runCatching { json.parseToJsonElement(p.getString(PINS, "{}") ?: "{}") as JsonObject }.getOrDefault(JsonObject(emptyMap())).toMutableMap()
        val changed = mutableSetOf<Long>()
        for (k in keys) {
            val jwk = runCatching { json.parseToJsonElement(k.public_key_jwk) as JsonObject }.getOrNull() ?: continue
            val id = "${k.user_id}:${k.device_id}"
            val now = fp(jwk)
            val old = (pins[id] as? JsonPrimitive)?.content
            if (old != null && old != now) changed += k.user_id
            pins[id] = JsonPrimitive(now)
        }
        p.edit().putString(PINS, JsonObject(pins).toString()).apply()
        return changed.toList()
    }

    private var senderKeyCache: Pair<Long, MutableMap<Long, List<String>>> = 0L to mutableMapOf()
    private suspend fun senderKeyKnown(senderId: Long, jwk: JsonObject): Boolean {
        if (System.currentTimeMillis() - senderKeyCache.first > 30_000) senderKeyCache = System.currentTimeMillis() to mutableMapOf()
        val list = senderKeyCache.second.getOrPut(senderId) {
            runCatching { SessionManager.api.deviceKeys(listOf(senderId)) }.getOrDefault(emptyList()).map {
                runCatching { fp(json.parseToJsonElement(it.public_key_jwk) as JsonObject) }.getOrDefault("")
            }
        }
        return list.contains(fp(jwk))
    }

    suspend fun encryptForRecipients(context: Context, plaintext: String, recipientUserIds: List<Long>, senderId: Long, convo: String): EncryptedPayload {
        val bundle = getOrCreateKeyPair(context)
        val allKeys = SessionManager.api.deviceKeys(recipientUserIds)
        if (allKeys.isEmpty()) throw IllegalStateException("No recipient has encryption set up on any device yet")
        if (checkPins(context, allKeys).isNotEmpty()) {
            throw IllegalStateException("A recipient's encryption key changed since you last wrote to them. Check with them if unexpected, then send again.")
        }
        val aad = aadBytes(senderId, convo)

        val contentKeyBytes = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
        val contentKey = SecretKeySpec(contentKeyBytes, "AES")
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, contentKey, GCMParameterSpec(128, iv))
        cipher.updateAAD(aad)
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        val entries = mutableListOf<WrappedKeyEntry>()
        for (dk: DeviceKey in allKeys) {
            try {
                val peerJwk = json.parseToJsonElement(dk.public_key_jwk) as JsonObject
                val peerPub = publicKeyFromJwk(peerJwk)
                val wrapKey = deriveWrapKey(bundle.private, peerPub)
                val wrapIv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
                val wrapCipher = Cipher.getInstance("AES/GCM/NoPadding")
                wrapCipher.init(Cipher.ENCRYPT_MODE, wrapKey, GCMParameterSpec(128, wrapIv))
                wrapCipher.updateAAD(aad)
                val wrapped = wrapCipher.doFinal(contentKeyBytes)
                entries += WrappedKeyEntry(
                    v = 2, user_id = dk.user_id, device_id = dk.device_id,
                    wrapped_key = b64std(wrapped), wrap_iv = b64std(wrapIv),
                    sender_pub_jwk = bundle.publicJwk,
                )
            } catch (_: Exception) {
                // a malformed/incompatible key on one device shouldn't sink the whole send
            }
        }
        return EncryptedPayload(
            ciphertext = b64std(ciphertext),
            iv = b64std(iv),
            encKeys = json.encodeToString(ListSerializer(WrappedKeyEntry.serializer()), entries),
        )
    }

    private fun b64std(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun b64stdDecode(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

    private val decryptCache = mutableMapOf<Long, String?>()

    /** Drop decrypted plaintext held in memory when the active account changes. */
    fun clearOnLogout() {
        decryptCache.clear()
        cached = null
        cachedFor = null
    }

    suspend fun decryptMessageContent(
        context: Context, id: Long, isEncrypted: Boolean, content: String, encIv: String?, encKeys: String?,
        senderId: Long? = null, recipientId: Long? = null, groupId: Long? = null,
    ): String? {
        if (!isEncrypted) return content
        decryptCache[id]?.let { return it }
        if (!decryptCache.containsKey(id)) {
            val result = runCatching { decryptNow(context, content, encIv, encKeys, senderId, recipientId, groupId) }.getOrNull()
            decryptCache[id] = result
            return result
        }
        return null
    }

    private suspend fun decryptNow(context: Context, content: String, encIv: String?, encKeysJson: String?, senderId: Long?, recipientId: Long?, groupId: Long?): String? {
        if (encIv == null || encKeysJson == null) return null
        val entries = runCatching { json.decodeFromString<List<WrappedKeyEntry>>(encKeysJson) }.getOrNull() ?: return null
        val myDeviceId = Prefs.deviceId(context)
        // Sealed for this device, or else for the account's key backup (a
        // message from before this device existed, readable after restoring).
        val own = entries.firstOrNull { it.device_id == myDeviceId }
        val mine: WrappedKeyEntry
        val myPriv: PrivateKey
        if (own != null) {
            mine = own
            myPriv = getOrCreateKeyPair(context).private
        } else {
            mine = entries.firstOrNull { it.device_id == BACKUP_DEVICE && it.user_id == currentUserId() } ?: return null
            myPriv = backupPrivateKey(context) ?: return null
        }
        var aad: ByteArray? = null
        if (mine.v == 2) {
            // v2 must say who sent it and where, and the sender's key must be one they registered.
            if (senderId == null) return null
            val convo = convoOf(senderId, recipientId, groupId) ?: return null
            if (!senderKeyKnown(senderId, mine.sender_pub_jwk)) return null
            aad = aadBytes(senderId, convo)
        }
        val senderPub = publicKeyFromJwk(mine.sender_pub_jwk)
        val wrapKey = deriveWrapKey(myPriv, senderPub)
        val unwrapCipher = Cipher.getInstance("AES/GCM/NoPadding")
        unwrapCipher.init(Cipher.DECRYPT_MODE, wrapKey, GCMParameterSpec(128, b64stdDecode(mine.wrap_iv)))
        aad?.let { unwrapCipher.updateAAD(it) }
        val rawContentKey = unwrapCipher.doFinal(b64stdDecode(mine.wrapped_key))
        val contentKey = SecretKeySpec(rawContentKey, "AES")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, contentKey, GCMParameterSpec(128, b64stdDecode(encIv)))
        aad?.let { cipher.updateAAD(it) }
        val plain = cipher.doFinal(b64stdDecode(content))
        return String(plain, Charsets.UTF_8)
    }

    private val json = Json { ignoreUnknownKeys = true }

    // ---- account key backup ----
    //
    // Same scheme and format as the web app (web/src/lib/crypto.ts): an extra
    // "backup" key pair whose public key is registered like another device of
    // the user, so new messages are sealed for it too. Its private key is kept
    // on the server encrypted with a password (PBKDF2-SHA256 + AES-GCM).

    private const val BACKUP_DEVICE = "backup"
    private const val PBKDF2_ITERATIONS = 600_000
    private fun backupPrivPref(userId: Long) = "backup_priv:$userId"

    private fun backupPrivateKey(context: Context): PrivateKey? {
        val stored = prefs(context).getString(backupPrivPref(currentUserId()), null) ?: return null
        return runCatching { KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(b64stdDecode(stored))) }.getOrNull()
    }

    /** Whether this device can already read messages sealed for the backup. */
    fun hasBackupKey(context: Context): Boolean = prefs(context).contains(backupPrivPref(currentUserId()))

    private fun passwordKey(password: String, salt: ByteArray, iterations: Int): SecretKeySpec {
        val factory = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val spec = javax.crypto.spec.PBEKeySpec(password.toCharArray(), salt, iterations, 256)
        return SecretKeySpec(factory.generateSecret(spec).encoded, "AES")
    }

    private fun seal(pkcs8: ByteArray, password: String): JsonObject {
        val random = java.security.SecureRandom()
        val salt = ByteArray(16).also { random.nextBytes(it) }
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, passwordKey(password, salt, PBKDF2_ITERATIONS), GCMParameterSpec(128, iv))
        return JsonObject(mapOf(
            "v" to JsonPrimitive(1),
            "kdf" to JsonPrimitive("PBKDF2-SHA256"),
            "iterations" to JsonPrimitive(PBKDF2_ITERATIONS),
            "salt" to JsonPrimitive(b64std(salt)),
            "iv" to JsonPrimitive(b64std(iv)),
            "ciphertext" to JsonPrimitive(b64std(cipher.doFinal(pkcs8))),
        ))
    }

    private fun storeBackupKey(context: Context, pkcs8: ByteArray) {
        prefs(context).edit().putString(backupPrivPref(currentUserId()), b64std(pkcs8)).apply()
        decryptCache.clear()
    }

    /** Turns on backup, or replaces it with a new key and password. */
    suspend fun createKeyBackup(context: Context, password: String) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec(CURVE)) }.generateKeyPair()
        val jwk = publicKeyToJwk(pair.public as java.security.interfaces.ECPublicKey)
        SessionManager.api.saveKeyBackup(seal(pair.private.encoded, password), jwk.toString())
        storeBackupKey(context, pair.private.encoded)
    }

    /** Re-encrypts the existing backup key with a new password. */
    suspend fun changeKeyBackupPassword(context: Context, password: String) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
        val stored = prefs(context).getString(backupPrivPref(currentUserId()), null)
            ?: throw IllegalStateException("Restore the backup on this device first")
        val pub = SessionManager.api.deviceKeys(listOf(currentUserId())).firstOrNull { it.device_id == BACKUP_DEVICE }
            ?: throw IllegalStateException("There is no backup to update")
        SessionManager.api.saveKeyBackup(seal(b64stdDecode(stored), password), pub.public_key_jwk)
    }

    /** Unlocks the account's backup on this device with its password. */
    suspend fun restoreKeyBackup(context: Context, password: String) = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
        val data = SessionManager.api.keyBackup().data ?: throw IllegalStateException("There is no backup for this account")
        fun field(name: String) = (data[name] as? JsonPrimitive)?.content ?: throw IllegalStateException("The backup is damaged")
        // Never trust KDF cost from the server: too low weakens, too high hangs the app.
        val iterations = field("iterations").toIntOrNull()?.takeIf { it in 100_000..10_000_000 }
            ?: throw IllegalStateException("The backup uses unsupported key-derivation settings")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, passwordKey(password, b64stdDecode(field("salt")), iterations), GCMParameterSpec(128, b64stdDecode(field("iv"))))
        val pkcs8 = try {
            cipher.doFinal(b64stdDecode(field("ciphertext")))
        } catch (e: javax.crypto.AEADBadTagException) {
            throw IllegalArgumentException("That password doesn't match the backup")
        }
        KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8)) // must be a valid key
        storeBackupKey(context, pkcs8)
    }

    suspend fun deleteKeyBackup(context: Context) {
        SessionManager.api.deleteKeyBackup()
        prefs(context).edit().remove(backupPrivPref(currentUserId())).apply()
    }
}
