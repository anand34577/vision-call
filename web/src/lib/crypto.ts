// Client-side end-to-end encryption for chat messages. The server (see
// lib/api.ts's device key endpoints) only ever stores and relays public
// keys and ciphertext — it has no key material that could decrypt anything
// here, by construction.
//
// Scheme, per message:
//   1. Generate a random AES-256-GCM "content key" + IV, encrypt the text.
//   2. For every recipient device (every current member's every registered
//      device, plus the sender's own other devices), derive a per-device
//      wrapping key via ECDH(senderPriv, deviceRecipientPub) and use it to
//      wrap the content key with its own IV.
//   3. Ship ciphertext + iv + the array of per-device wrapped keys.
// Decrypting is the mirror: find your own device's entry, re-derive the
// same ECDH shared secret (ECDH is symmetric — recipientPriv+senderPub
// gives the same result), unwrap the content key, decrypt.
//
// This has no ratcheting/forward-secrecy beyond "one fresh AES key per
// message" — a real Signal-style double-ratchet is out of scope here.
import { deviceID } from "./ws";
import { api } from "./api";

const DB_NAME = "vc-e2e-keys";
const STORE = "keypair";
// Keypairs are per account (record "device:<userID>"), not per browser: on a
// shared machine the next person to sign in must not inherit — and publish
// under their own account — the previous user's private key. "device" is
// the old single, browser-wide record, adopted once by its real owner.
const LEGACY_RECORD_KEY = "device";
const recordKey = (userID: number) => `device:${userID}`;

interface StoredKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

interface WrappedKeyEntry {
  /** 2 = ciphertext and key wraps are bound to sender + conversation (AAD). */
  v?: number;
  user_id: number;
  device_id: string;
  wrapped_key: string; // base64
  wrap_iv: string; // base64
  sender_pub_jwk: JsonWebKey;
}

function openKeyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly").objectStore(store).get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite").objectStore(store).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(store: string, key: string, value: unknown): Promise<void> {
  const db = await openKeyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite").objectStore(store).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let cachedKeyPair: StoredKeyPair | null = null;
let registerPromise: Promise<void> | null = null;
let currentUserID: number | null = null;

// adoptLegacyKeyPair returns the old browser-wide keypair only if the server
// has it registered as this user's key for this device — i.e. it really was
// theirs — then moves it to the per-account record.
async function adoptLegacyKeyPair(userID: number): Promise<StoredKeyPair | undefined> {
  const legacy = await idbGet<StoredKeyPair>(STORE, LEGACY_RECORD_KEY);
  if (!legacy) return undefined;
  try {
    const pub = await crypto.subtle.exportKey("jwk", legacy.publicKey);
    const mine = (await api.deviceKeys([userID])).find((k) => k.device_id === deviceID());
    const registered = mine ? (JSON.parse(mine.public_key_jwk) as JsonWebKey) : null;
    if (!registered || registered.x !== pub.x || registered.y !== pub.y) return undefined;
  } catch {
    return undefined;
  }
  await idbSet(STORE, recordKey(userID), legacy);
  await idbDelete(STORE, LEGACY_RECORD_KEY);
  return legacy;
}

export function isCryptoSubtleAvailable(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

// getDeviceKeyPair returns this browser's ECDH keypair, generating one
// (non-extractable private key — it can never be read back out, only used)
// the first time and persisting it in IndexedDB from then on.
async function getDeviceKeyPair(): Promise<StoredKeyPair> {
  if (!isCryptoSubtleAvailable()) {
    throw new Error("WebCrypto is unavailable in insecure HTTP contexts. Connect over HTTPS to enable encryption.");
  }
  if (cachedKeyPair) return cachedKeyPair;
  const userID = currentUserID;
  if (userID == null) throw new Error("E2E keys are not available before sign-in");
  const stored = (await idbGet<StoredKeyPair>(STORE, recordKey(userID))) ?? (await adoptLegacyKeyPair(userID));
  if (stored) {
    cachedKeyPair = stored;
    return stored;
  }
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveKey",
  ])) as CryptoKeyPair;
  // The public key must be extractable to export as JWK for the server;
  // generateKey's `extractable` flag applies to both halves of the pair, so
  // re-derive an extractable public key by exporting/reimporting it — the
  // private key from generateKey (extractable: false) never had that option.
  const rawPub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const extractablePub = await crypto.subtle.importKey(
    "jwk", rawPub, { name: "ECDH", namedCurve: "P-256" }, true, [],
  );
  const record: StoredKeyPair = { publicKey: extractablePub, privateKey: pair.privateKey };
  await idbSet(STORE, recordKey(userID), record);
  cachedKeyPair = record;
  return record;
}

// ensureRegistered publishes this device's public key to the server, once
// per app load. Safe to call repeatedly (idempotent server-side upsert).
export function ensureDeviceRegistered(userID: number): Promise<void> {
  if (!isCryptoSubtleAvailable()) {
    return Promise.resolve();
  }
  if (currentUserID !== userID) {
    currentUserID = userID;
    cachedKeyPair = null;
    registerPromise = null;
  }
  if (!registerPromise) {
    registerPromise = (async () => {
      const { publicKey } = await getDeviceKeyPair();
      const jwk = await crypto.subtle.exportKey("jwk", publicKey);
      await api.registerDeviceKey(deviceID(), JSON.stringify(jwk));
    })().catch((err) => {
      // A failed attempt must not be cached forever: allow the next call to retry.
      registerPromise = null;
      throw err;
    });
  }
  return registerPromise;
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function b64decode(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveWrapKey(privateKey: CryptoKey, peerPublicJwk: JsonWebKey): Promise<CryptoKey> {
  const peerPub = await crypto.subtle.importKey("jwk", peerPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: peerPub }, privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/** Who sent a message and where: bound into the encryption as AAD (v2). */
export interface CryptoContext {
  senderID: number;
  /** "dm:<lowId>-<highId>" or "g:<groupId>" */
  convo: string;
}

export function convoOf(m: { sender_id: number; recipient_id: number | null; group_id: number | null }): string | null {
  if (m.group_id != null) return `g:${m.group_id}`;
  if (m.recipient_id != null) return `dm:${Math.min(m.sender_id, m.recipient_id)}-${Math.max(m.sender_id, m.recipient_id)}`;
  return null;
}

const aadBytes = (ctx: CryptoContext) => new TextEncoder().encode(`vc2|${ctx.senderID}|${ctx.convo}`);

// ---- key pinning (trust on first use) ----
// The server hands out every device key, so a rogue or compromised server
// could slip in its own. Remember the first key seen per (user, device) and
// refuse once when it later changes, so the user gets a chance to notice.
const PIN_KEY = "vc.keypins.v1";
const fp = (jwk: JsonWebKey) => `${jwk.x}.${jwk.y}`;
function loadPins(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePins(p: Record<string, string>) {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(p));
  } catch {
    /* private mode: pinning just won't persist */
  }
}
/** Returns the user ids whose key for an already-known device changed. Pins are updated, so a retry goes through. */
function checkPins(keys: { user_id: number; device_id: string; public_key_jwk: string }[]): number[] {
  const pins = loadPins();
  const changed = new Set<number>();
  for (const k of keys) {
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(k.public_key_jwk);
    } catch {
      continue;
    }
    const id = `${k.user_id}:${k.device_id}`;
    const now = fp(jwk);
    if (pins[id] && pins[id] !== now) changed.add(k.user_id);
    pins[id] = now;
  }
  savePins(pins);
  return [...changed];
}

let senderKeyCache: { at: number; byUser: Map<number, string[]> } = { at: 0, byUser: new Map() };
async function senderKeyKnown(senderID: number, jwk: JsonWebKey): Promise<boolean> {
  if (Date.now() - senderKeyCache.at > 30_000) senderKeyCache = { at: Date.now(), byUser: new Map() };
  let list = senderKeyCache.byUser.get(senderID);
  if (!list) {
    const keys = await api.deviceKeys([senderID]);
    list = keys.map((k) => {
      try {
        return fp(JSON.parse(k.public_key_jwk));
      } catch {
        return "";
      }
    });
    senderKeyCache.byUser.set(senderID, list);
  }
  return list.includes(fp(jwk));
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  encKeys: string; // JSON-stringified WrappedKeyEntry[]
}

// canEncryptTo checks whether every target user has at least one registered
// device key — the gate for showing/using the "encrypt this conversation"
// toggle. Returns the userIDs that are NOT ready, for a useful error.
export async function usersMissingKeys(userIDs: number[]): Promise<number[]> {
  const keys = await api.deviceKeys(userIDs);
  const ready = new Set(keys.map((k) => k.user_id));
  return userIDs.filter((id) => !ready.has(id));
}

// encryptForRecipients encrypts plaintext for every device of every user in
// recipientUserIDs (which should include the sender's own id, so their
// other devices/history sync too — callers pass the full participant set).
export async function encryptForRecipients(plaintext: string, recipientUserIDs: number[], ctx: CryptoContext): Promise<EncryptedPayload> {
  const { publicKey, privateKey } = await getDeviceKeyPair();
  const ownPubJwk = await crypto.subtle.exportKey("jwk", publicKey);

  const allKeys = await api.deviceKeys(recipientUserIDs);
  if (allKeys.length === 0) {
    throw new Error("No recipient has encryption set up on any device yet");
  }
  const changed = checkPins(allKeys);
  if (changed.length > 0) {
    throw new Error("A recipient's encryption key changed since you last wrote to them (new device or reset). Check with them if unexpected, then send again.");
  }
  const aad = aadBytes(ctx);

  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, contentKey, new TextEncoder().encode(plaintext));
  const rawContentKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey));

  // Every device gets a wrapped key, including the sender's own current
  // one — reloading the page (or another tab) later needs to re-derive the
  // plaintext from stored history same as any other device would.
  const encKeys: WrappedKeyEntry[] = [];
  for (const dk of allKeys) {
    try {
      const wrapKey = await deriveWrapKey(privateKey, JSON.parse(dk.public_key_jwk));
      const wrapIv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv, additionalData: aad }, wrapKey, rawContentKey);
      encKeys.push({
        v: 2,
        user_id: dk.user_id, device_id: dk.device_id,
        wrapped_key: b64encode(wrapped), wrap_iv: b64encode(wrapIv.buffer as ArrayBuffer),
        sender_pub_jwk: ownPubJwk as JsonWebKey,
      });
    } catch {
      // A malformed/incompatible key on one device shouldn't sink the whole send.
    }
  }

  return {
    ciphertext: b64encode(ciphertextBuf),
    iv: b64encode(iv.buffer as ArrayBuffer),
    encKeys: JSON.stringify(encKeys),
  };
}

const MAX_DECRYPT_CACHE = 500;
const decryptCache = new Map<number, string>();

// Drop decrypted plaintext held in memory when the active account changes —
// this app is designed to run on shared/kiosk-style devices, so decrypted
// content from a previous session must not linger in memory indefinitely.
export function clearDecryptCache(): void {
  decryptCache.clear();
  cachedKeyPair = null;
  registerPromise = null;
  currentUserID = null;
}

// decryptMessageContent returns the plaintext for an encrypted message on
// this device, or null if this device has no wrapped key for it (sent
// before this device registered, or the sender excluded it). Results are
// cached by message id since decryption is a few async crypto calls.
export async function decryptMessageContent(msg: { id: number; is_encrypted: boolean; content: string; enc_iv?: string | null; enc_keys?: string | null; sender_id?: number; recipient_id?: number | null; group_id?: number | null }): Promise<string | null> {
  if (!msg.is_encrypted) return msg.content;
  if (!isCryptoSubtleAvailable()) return "[Encrypted message — HTTPS required to decrypt]";
  if (decryptCache.has(msg.id)) {
    const val = decryptCache.get(msg.id)!;
    decryptCache.delete(msg.id);
    decryptCache.set(msg.id, val);
    return val;
  }
  const result = await decryptNow(msg);
  if (result !== null) {
    if (decryptCache.size >= MAX_DECRYPT_CACHE) {
      const oldestKey = decryptCache.keys().next().value;
      if (oldestKey !== undefined) {
        decryptCache.delete(oldestKey);
      }
    }
    decryptCache.set(msg.id, result);
  }
  return result;
}

async function decryptNow(msg: { content: string; enc_iv?: string | null; enc_keys?: string | null; sender_id?: number; recipient_id?: number | null; group_id?: number | null }): Promise<string | null> {
  if (!msg.enc_keys || !msg.enc_iv) return null;
  let entries: WrappedKeyEntry[];
  try {
    entries = JSON.parse(msg.enc_keys);
  } catch {
    return null;
  }
  const myDeviceId = deviceID();
  // Sealed for this device, or else for the account's key backup (a message
  // from before this device existed, readable after restoring the backup).
  let mine = entries.find((e) => e.device_id === myDeviceId);
  let privateKey: CryptoKey | undefined;
  if (!mine) {
    mine = entries.find((e) => e.device_id === BACKUP_DEVICE_ID && e.user_id === currentUserID);
    privateKey = mine ? await backupPrivateKey() : undefined;
    if (!mine || !privateKey) return null;
  }
  try {
    let aad: Uint8Array | undefined;
    if (mine.v === 2) {
      // v2: must know who sent it and where, and the sender's key must be one
      // the sender actually has registered.
      const convo = msg.sender_id != null ? convoOf({ sender_id: msg.sender_id, recipient_id: msg.recipient_id ?? null, group_id: msg.group_id ?? null }) : null;
      if (msg.sender_id == null || !convo) return null;
      if (!(await senderKeyKnown(msg.sender_id, mine.sender_pub_jwk))) return null;
      aad = aadBytes({ senderID: msg.sender_id, convo });
    }
    privateKey ??= (await getDeviceKeyPair()).privateKey;
    const wrapKey = await deriveWrapKey(privateKey, mine.sender_pub_jwk);
    const rawContentKey = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(mine.wrap_iv), ...(aad ? { additionalData: aad } : {}) }, wrapKey, b64decode(mine.wrapped_key));
    const contentKey = await crypto.subtle.importKey("raw", rawContentKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(msg.enc_iv), ...(aad ? { additionalData: aad } : {}) }, contentKey, b64decode(msg.content));
    return new TextDecoder().decode(plainBuf);
  } catch {
    return null;
  }
}

// ---- account key backup ----
//
// Turning on backup makes one extra "backup" key pair for the account. Its
// public key is registered like another device of the user, so everyone
// seals new messages for it too. Its private key is stored on the server,
// encrypted with a password only the user knows (PBKDF2 + AES-GCM). On a new
// device, entering that password unlocks every message sent since backup
// was turned on. The Android app uses the same format.

const BACKUP_DEVICE_ID = "backup";
const PBKDF2_ITERATIONS = 600_000;
const backupRecordKey = (userID: number) => `backup:${userID}`;

interface KeyBackupData {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string; // the backup private key, PKCS#8, AES-GCM encrypted
}

async function passwordKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function backupPrivateKey(): Promise<CryptoKey | undefined> {
  if (currentUserID == null) return undefined;
  return idbGet<CryptoKey>(STORE, backupRecordKey(currentUserID));
}

/** Whether this device can already read messages sealed for the backup. */
export async function hasBackupKeyOnDevice(): Promise<boolean> {
  if (!isCryptoSubtleAvailable()) return false;
  return !!(await backupPrivateKey());
}

async function sealBackup(pkcs8: ArrayBuffer, password: string): Promise<KeyBackupData> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pkcs8);
  return {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITERATIONS,
    salt: b64encode(salt.buffer as ArrayBuffer),
    iv: b64encode(iv.buffer as ArrayBuffer),
    ciphertext: b64encode(ciphertext),
  };
}

async function storeBackupKey(pkcs8: ArrayBuffer) {
  if (currentUserID == null) throw new Error("Not signed in");
  // Kept extractable so the password can be changed later from this device.
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  await idbSet(STORE, backupRecordKey(currentUserID), priv);
  decryptCache.clear();
}

/** Turns on backup, or replaces it with a new key and password. */
export async function createKeyBackup(password: string): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const data = await sealBackup(pkcs8, password);
  await api.saveKeyBackup(data, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  await storeBackupKey(pkcs8);
}

/**
 * Re-encrypts the existing backup key with a new password, keeping it valid
 * for everything already sealed for it. Needs the key on this device.
 */
export async function changeKeyBackupPassword(password: string): Promise<void> {
  const priv = await backupPrivateKey();
  if (!priv) throw new Error("Restore the backup on this device first");
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", priv);
  const status = await api.keyBackup();
  const keys = await api.deviceKeys([currentUserID!]);
  const pub = keys.find((k) => k.device_id === BACKUP_DEVICE_ID);
  if (!status.exists || !pub) throw new Error("There is no backup to update");
  await api.saveKeyBackup(await sealBackup(pkcs8, password), pub.public_key_jwk);
}

/** Unlocks the account's backup on this device with its password. */
export async function restoreKeyBackup(password: string): Promise<void> {
  const status = await api.keyBackup();
  if (!status.exists || !status.data) throw new Error("There is no backup for this account");
  const d = status.data as KeyBackupData;
  // Never trust KDF cost from the server: too low weakens, too high hangs the tab.
  if (!Number.isInteger(d.iterations) || d.iterations < 100_000 || d.iterations > 10_000_000) {
    throw new Error("The backup uses unsupported key-derivation settings");
  }
  const key = await passwordKey(password, b64decode(d.salt), d.iterations);
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(d.iv) as BufferSource }, key, b64decode(d.ciphertext) as BufferSource);
  } catch {
    throw new Error("That password doesn't match the backup");
  }
  await storeBackupKey(pkcs8);
}

export async function deleteKeyBackup(): Promise<void> {
  await api.deleteKeyBackup();
  if (currentUserID != null) await idbDelete(STORE, backupRecordKey(currentUserID));
}
