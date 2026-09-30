import { create } from "zustand";
import { api } from "../lib/api";
import { ws } from "../lib/ws";
import { notify } from "../lib/media";
import { usePresence } from "./presence";
import { encryptForRecipients, decryptMessageContent, usersMissingKeys } from "../lib/crypto";
import type { Convo, ConvoPref, Group, Message, MessagePreview } from "../lib/types";
import { useAuth } from "./auth";
import { useDirectory } from "./directory";
import { toast } from "./toast";

// isMentioned reports whether content contains "@username" as a whole token
// (not just a substring of a longer name), case-insensitively.
// mentionedIDs resolves "@username" tokens in text to user ids from the
// directory. The ids travel as message metadata so mentions still notify
// people when the text itself is end-to-end encrypted.
export function mentionedIDs(text: string): number[] {
  const users = useDirectory.getState().users;
  const ids = new Set<number>();
  for (const m of text.matchAll(/(^|\s)@([a-zA-Z0-9._-]{2,32})/g)) {
    const u = users.find((x) => x.username.toLowerCase() === m[2].toLowerCase());
    if (u) ids.add(u.id);
  }
  return [...ids];
}

export function isMentioned(content: string, username: string): boolean {
  if (!username) return false;
  const re = new RegExp(`(^|\\s)@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(content);
}

// Whether a conversation is E2E-encrypted is a per-device UI choice (once
// turned on, only this browser remembers it — it doesn't change how other
// participants' clients behave). Persisted so it survives a reload. A first
// visit on a *new* device has no local preference yet — rather than always
// defaulting to "off" (which would silently drop back to plaintext for a
// conversation the user already encrypted elsewhere), loadMessages below
// seeds the default from whether the most recent message actually was
// encrypted, so a new device picks up the conversation's real state instead
// of a per-browser guess. The stored value is always "0" or "1" (never
// absent) specifically so "explicitly off" and "never set on this device"
// can be told apart.
// "v2": earlier versions stored a guess (copied from the last message) for
// every chat opened, which would now read as a deliberate "off".
function e2eStorageKey(convoKey: string) { return `vc.e2e.v2.${convoKey}`; }
// Chats are end-to-end encrypted unless someone turned it off for that chat.
// Browsers only allow the encryption over HTTPS, so plain HTTP stays off.
function loadE2EFlag(convoKey: string): boolean {
  if (!window.isSecureContext) return false;
  try {
    const stored = localStorage.getItem(e2eStorageKey(convoKey));
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}
function hasExplicitE2EFlag(convoKey: string): boolean {
  try { return localStorage.getItem(e2eStorageKey(convoKey)) !== null; } catch { return false; }
}
function saveE2EFlag(convoKey: string, on: boolean) {
  try { localStorage.setItem(e2eStorageKey(convoKey), on ? "1" : "0"); } catch { /* private mode / quota — the toggle just won't persist */ }
}

function key(c: Convo): string {
  return c.kind === "dm" ? `dm:${c.peerID}` : `g:${c.groupID}`;
}

function messageOrder(a: Message, b: Message): number {
  const byTime = Date.parse(a.sent_at) - Date.parse(b.sent_at);
  return Number.isNaN(byTime) || byTime === 0 ? a.id - b.id : byTime;
}

// updateMessage patches one message id, wherever it lives in a DM or group
// bucket, with `updater`. The sender/recipient pair alone doesn't say which
// bucket a DM lives in (it's keyed by "the other party"), so this resolves
// that from whichever side of the DM isn't us.
function updateMessage(
  set: (fn: (s: ChatsState) => Partial<ChatsState>) => void,
  ref: { id: number; sender_id: number; recipient_id: number | null; group_id: number | null },
  updater: (m: Message) => Message,
) {
  const apply = (list: Message[]) => list.map((m) => (m.id === ref.id ? updater(m) : m));
  if (ref.group_id != null) {
    set((s) => ({ messagesByGroup: { ...s.messagesByGroup, [ref.group_id!]: apply(s.messagesByGroup[ref.group_id!] ?? []) } }));
    return;
  }
  const me = useAuth.getState().me;
  const peerID = me && ref.sender_id === me.id ? ref.recipient_id : ref.sender_id;
  if (peerID == null) return;
  set((s) => ({ messagesByDm: { ...s.messagesByDm, [peerID]: apply(s.messagesByDm[peerID] ?? []) } }));
}

// bumpThread adds one to a thread root's reply count when a new reply lands.
function bumpThread(set: (fn: (s: ChatsState) => Partial<ChatsState>) => void, msg: Message) {
  const rootID = msg.thread_root_id;
  if (!rootID) return;
  const bump = (list: Message[] = []) => list.map((m) => (m.id === rootID ? { ...m, thread_count: (m.thread_count ?? 0) + 1 } : m));
  if (msg.group_id != null) {
    set((s) => ({ messagesByGroup: { ...s.messagesByGroup, [msg.group_id!]: bump(s.messagesByGroup[msg.group_id!]) } }));
    return;
  }
  const me = useAuth.getState().me;
  const peer = me && msg.sender_id === me.id ? msg.recipient_id : msg.sender_id;
  if (peer != null) set((s) => ({ messagesByDm: { ...s.messagesByDm, [peer]: bump(s.messagesByDm[peer]) } }));
}

function markDeleted(
  set: (fn: (s: ChatsState) => Partial<ChatsState>) => void,
  ref: { id: number; sender_id: number; recipient_id: number | null; group_id: number | null },
) {
  updateMessage(set, ref, (m) => ({ ...m, content: "", file: undefined, file_id: null, deleted_at: new Date().toISOString() }));
}

// buildReplyPreview builds the client-side equivalent of the server's reply
// preview from a message already in the store, for the optimistic bubble —
// the server's own preview arrives on the "message:sent" ack a moment later.
function buildReplyPreview(m: Message): MessagePreview {
  return { id: m.id, content: m.content, has_file: !!m.file_id, deleted: !!m.deleted_at, is_encrypted: m.is_encrypted, sender: m.sender };
}

interface ChatsState {
  messagesByDm: Record<number, Message[]>;
  messagesByGroup: Record<number, Message[]>;
  groups: Group[];
  active: Convo | null;
  // peerID / groupID -> memberID -> last typing timestamp (ms)
  typingDm: Record<number, number>;
  typingGroup: Record<number, Record<number, { name: string; time: number }>>;
  unread: Record<string, number>;
  /** A call is covering the chat, so it isn't actually being read. */
  callCovering: boolean;
  sendError: string | null;
  historyLoading: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  /** Per-conversation mute/archive, keyed like `dm:5` / `g:3`. */
  convoPrefs: Record<string, ConvoPref>;
  /** groupID -> userID -> last message id that user has read. */
  groupReads: Record<number, Record<number, number>>;
  /** ids of the people I have blocked. */
  blocked: number[];
  fetchBlocked: () => Promise<void>;
  setBlocked: (userID: number, blocked: boolean) => Promise<void>;
  loadThread: (rootID: number) => Promise<void>;
  votePoll: (pollID: number, optionID: number) => void;
  closePoll: (pollID: number) => void;
  fetchConvoPrefs: () => Promise<void>;
  setConvoPref: (c: Convo, patch: { muted?: boolean; archived?: boolean }) => Promise<void>;
  fetchGroupReads: (groupID: number) => Promise<void>;

  setActive: (c: Convo | null) => void;
  clearSendError: () => void;
  openDm: (peerID: number) => void;
  openGroup: (groupID: number) => void;
  loadMessages: (c: Convo, before?: number) => Promise<void>;
  fetchGroups: () => Promise<void>;
  fetchRecent: () => Promise<void>;
  sendMessage: (
    c: Convo,
    content: string,
    fileID?: number,
    replyToID?: number,
    opts?: { threadRootID?: number; poll?: { question: string; options: string[]; multi: boolean } },
  ) => void;
  retryMessage: (msg: Message) => void;
  deleteMessage: (msg: Message) => void;
  editMessage: (msg: Message, content: string) => void;
  reactToMessage: (msg: Message, emoji: string) => void;
  deleteGroup: (groupID: number) => Promise<void>;
  renameGroup: (groupID: number, name: string) => Promise<void>;
  updateGroup: (groupID: number, body: { name?: string; topic?: string; avatar_file_id?: number }) => Promise<void>;
  setGroupMemberRole: (groupID: number, userID: number, role: "admin" | "member") => Promise<void>;
  addGroupMembers: (groupID: number, memberIDs: number[]) => Promise<void>;
  removeGroupMember: (groupID: number, userID: number) => Promise<void>;
  pinMessage: (msg: Message, pinned: boolean) => void;
  savedIDs: Set<number>;
  fetchSaved: () => Promise<void>;
  toggleSave: (msg: Message) => Promise<void>;
  encryptedConvos: Record<string, boolean>;
  hydrateEncryptedFlag: (c: Convo) => void;
  decryptPending: (msgs: Message[]) => void;
  isEncrypted: (c: Convo) => boolean;
  setEncrypted: (c: Convo, on: boolean) => void;
  decryptedContent: Record<number, string | null>; // null = undecryptable on this device
  sendTyping: (c: Convo) => void;
  markRead: (c: Convo) => void;
  refreshUnread: () => void;
  registerWs: () => void;
}

let lastTypingSent = 0;
let wsRegistered = false;
let optimisticSequence = 0;

export const useChats = create<ChatsState>((set, get) => ({
  blocked: [],
  fetchBlocked: async () => {
    try {
      set({ blocked: await api.blockedUsers() });
    } catch {
      /* keep what we have */
    }
  },
  setBlocked: async (userID, blocked) => {
    if (blocked) await api.blockUser(userID);
    else await api.unblockUser(userID);
    await get().fetchBlocked();
  },
  loadThread: async (rootID) => {
    const replies = await api.thread(rootID);
    if (replies.length === 0) return;
    set((s) => {
      const merge = (list: Message[] = []) => {
        const byID = new Map(list.map((m) => [m.id, m]));
        for (const r of replies) byID.set(r.id, byID.get(r.id) ?? r);
        return [...byID.values()].sort(messageOrder);
      };
      const first = replies[0];
      if (first.group_id != null) return { messagesByGroup: { ...s.messagesByGroup, [first.group_id]: merge(s.messagesByGroup[first.group_id]) } };
      const me = useAuth.getState().me;
      const peer = me && first.sender_id === me.id ? first.recipient_id : first.sender_id;
      return peer == null ? {} : { messagesByDm: { ...s.messagesByDm, [peer]: merge(s.messagesByDm[peer]) } };
    });
    get().decryptPending(replies);
  },
  votePoll: (pollID, optionID) => {
    ws.send("poll:vote", { poll_id: pollID, option_id: optionID });
  },
  closePoll: (pollID) => {
    ws.send("poll:close", { poll_id: pollID });
  },
  convoPrefs: {},
  groupReads: {},
  fetchConvoPrefs: async () => {
    try {
      const list = await api.convoPrefs();
      const map: Record<string, ConvoPref> = {};
      for (const p of list) map[p.kind === "dm" ? `dm:${p.target_id}` : `g:${p.target_id}`] = p;
      set({ convoPrefs: map });
    } catch {
      /* keep what we have */
    }
  },
  setConvoPref: async (c, patch) => {
    const k = key(c);
    const cur = get().convoPrefs[k];
    const next: ConvoPref = {
      kind: c.kind,
      target_id: c.kind === "dm" ? c.peerID : c.groupID,
      muted: patch.muted ?? cur?.muted ?? false,
      archived: patch.archived ?? cur?.archived ?? false,
    };
    set((s) => ({ convoPrefs: { ...s.convoPrefs, [k]: next } }));
    try {
      await api.setConvoPref(next);
    } catch {
      set((s) => ({ convoPrefs: { ...s.convoPrefs, ...(cur ? { [k]: cur } : {}) } }));
    }
  },
  fetchGroupReads: async (groupID) => {
    try {
      const r = await api.groupReadState(groupID);
      const map: Record<number, number> = {};
      for (const [uid, id] of Object.entries(r)) map[Number(uid)] = id;
      set((s) => ({ groupReads: { ...s.groupReads, [groupID]: map } }));
    } catch {
      /* not fatal */
    }
  },

  messagesByDm: {},
  messagesByGroup: {},
  groups: [],
  active: null,
  typingDm: {},
  typingGroup: {},
  unread: {},
  callCovering: false,
  sendError: null,
  historyLoading: {},
  hasMore: {},
  savedIDs: new Set(),
  encryptedConvos: {},
  decryptedContent: {},

  setActive: (c) => set({ active: c }),
  clearSendError: () => set({ sendError: null }),

  openDm: (peerID) => {
    const c: Convo = { kind: "dm", peerID };
    set({ active: c });
    get().hydrateEncryptedFlag(c);
    get().loadMessages(c);
    get().markRead(c);
  },

  openGroup: (groupID) => {
    const c: Convo = { kind: "group", groupID };
    set({ active: c });
    get().hydrateEncryptedFlag(c);
    get().loadMessages(c);
    get().markRead(c);
  },

  hydrateEncryptedFlag: (c: Convo) => {
    const k = key(c);
    if (k in get().encryptedConvos) return;
    set((s) => ({ encryptedConvos: { ...s.encryptedConvos, [k]: loadE2EFlag(k) } }));
  },

  isEncrypted: (c) => !!get().encryptedConvos[key(c)],

  // Kicks off async decryption for any encrypted messages not already
  // cached, so the UI can render a placeholder then swap in plaintext a moment
  // later without blocking the message list on crypto work.
  decryptPending: (msgs) => {
    const cache = get().decryptedContent;
    for (const m of msgs) {
      if (!m.is_encrypted || m.id in cache) continue;
      decryptMessageContent(m).then((plain) => {
        set((s) => ({ decryptedContent: { ...s.decryptedContent, [m.id]: plain } }));
      });
    }
  },

  setEncrypted: (c, on) => {
    const k = key(c);
    saveE2EFlag(k, on);
    set((s) => ({ encryptedConvos: { ...s.encryptedConvos, [k]: on } }));
  },

  loadMessages: async (c, before) => {
    const k = key(c);
    if (get().historyLoading[k]) return;
    set((s) => ({ historyLoading: { ...s.historyLoading, [k]: true } }));
    try {
      const msgs = c.kind === "dm"
        ? await api.directMessages(c.peerID, before)
        : await api.groupMessages(c.groupID, before);
      set((s) => {
        const map = c.kind === "dm" ? { ...s.messagesByDm } : { ...s.messagesByGroup };
        const bucketKey = c.kind === "dm" ? c.peerID : c.groupID;
        const existing = map[bucketKey] ?? [];
        const byId = new Map<number, Message>();
        for (const m of existing) byId.set(m.id, m);
        for (const m of msgs) byId.set(m.id, m);
        map[bucketKey] = Array.from(byId.values()).sort(messageOrder);
        return {
          ...(c.kind === "dm" ? { messagesByDm: map as typeof s.messagesByDm } : { messagesByGroup: map as typeof s.messagesByGroup }),
          historyLoading: { ...s.historyLoading, [k]: false },
          hasMore: { ...s.hasMore, [k]: msgs.length >= 50 },
        };
      });
      get().decryptPending(msgs);
      // First time this conversation is opened on this device (no explicit
      // local preference recorded yet): default the toggle to match the most
      // recent message's actual encryption state, so a new/cleared device
      // doesn't silently present an encrypted conversation as plaintext-by-
      // default. before-set is only true when paging older history, in which
      // case a default has already been established by the initial load.
      // Encryption is on by default (see loadE2EFlag), so nothing to infer
      // from the history here.
    } catch {
      set((s) => ({ historyLoading: { ...s.historyLoading, [key(c)]: false } }));
    }
  },

  fetchGroups: async () => {
    try {
      const groups = await api.groups();
      set((s) => ({
        groups,
        active: s.active?.kind === "group" && !groups.some((g) => g.id === (s.active as { groupID: number }).groupID) ? null : s.active,
      }));
    } catch {
      /* ignore */
    }
  },

  // Seeds each conversation with its latest message so the chat list can
  // show previews and sort by recency before any chat has been opened.
  fetchRecent: async () => {
    const me = useAuth.getState().me;
    if (!me) return;
    let recent: { dms: Message[]; groups: Message[] };
    try {
      recent = await api.recentConversations();
    } catch {
      return;
    }
    const add = (list: Message[] | undefined, m: Message) =>
      list?.some((x) => x.id === m.id) ? list : [...(list ?? []), m].sort(messageOrder);
    set((s) => {
      const byDm = { ...s.messagesByDm };
      const byGroup = { ...s.messagesByGroup };
      for (const m of recent.dms) {
        const peer = m.sender_id === me.id ? m.recipient_id : m.sender_id;
        if (peer != null) byDm[peer] = add(byDm[peer], m);
      }
      for (const m of recent.groups) {
        if (m.group_id != null) byGroup[m.group_id] = add(byGroup[m.group_id], m);
      }
      // Chat-list previews of encrypted chats need the plaintext.
      queueMicrotask(() => get().decryptPending([...recent.dms, ...recent.groups]));
      return { messagesByDm: byDm, messagesByGroup: byGroup };
    });
    get().decryptPending([...recent.dms, ...recent.groups]);
  },

  deleteGroup: async (groupID: number) => {
    await api.deleteGroup(groupID);
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== groupID),
      active: s.active?.kind === "group" && s.active.groupID === groupID ? null : s.active,
    }));
  },

  renameGroup: async (groupID, name) => {
    const g = await api.renameGroup(groupID, name);
    set((s) => ({ groups: s.groups.map((x) => (x.id === groupID ? g : x)) }));
  },

  updateGroup: async (groupID, body) => {
    const g = await api.updateGroup(groupID, body);
    set((s) => ({ groups: s.groups.map((x) => (x.id === groupID ? g : x)) }));
  },

  setGroupMemberRole: async (groupID, userID, role) => {
    const g = await api.setGroupMemberRole(groupID, userID, role);
    set((s) => ({ groups: s.groups.map((x) => (x.id === groupID ? g : x)) }));
  },

  addGroupMembers: async (groupID, memberIDs) => {
    const g = await api.addGroupMembers(groupID, memberIDs);
    set((s) => ({ groups: s.groups.map((x) => (x.id === groupID ? g : x)) }));
  },

  removeGroupMember: async (groupID, userID) => {
    await api.removeGroupMember(groupID, userID);
    const me = useAuth.getState().me;
    if (me && userID === me.id) {
      // Left the group ourselves: it's no longer ours to see.
      set((s) => ({
        groups: s.groups.filter((g) => g.id !== groupID),
        active: s.active?.kind === "group" && s.active.groupID === groupID ? null : s.active,
      }));
      return;
    }
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === groupID ? { ...g, members: g.members.filter((m) => m.id !== userID) } : g,
      ),
    }));
  },

  deleteMessage: (msg: Message) => {
    if (!ws.send("message:delete", { id: msg.id })) return;
    // Optimistic; the server's "message:deleted" echo/broadcast confirms it,
    // a rejected delete just leaves the message as-is.
    markDeleted(set, msg);
  },

  editMessage: (msg: Message, content: string) => {
    const trimmed = content.trim();
    if (!trimmed || trimmed === msg.content) return;
    if (!ws.send("message:edit", { id: msg.id, content: trimmed })) return;
    // Optimistic; the server's "message:edited" echo/broadcast confirms it.
    updateMessage(set, msg, (m) => ({ ...m, content: trimmed, edited_at: new Date().toISOString() }));
  },

  reactToMessage: (msg: Message, emoji: string) => {
    const me = useAuth.getState().me;
    if (!me) return;
    if (!ws.send("message:react", { id: msg.id, emoji })) return;
    // Optimistic toggle; the server's "message:reaction" broadcast (which
    // also comes back to us) is the source of truth if this guess is wrong.
    const already = (msg.reactions ?? []).some((r) => r.user_id === me.id && r.emoji === emoji);
    updateMessage(set, msg, (m) => ({
      ...m,
      reactions: already
        ? (m.reactions ?? []).filter((r) => !(r.user_id === me.id && r.emoji === emoji))
        : [...(m.reactions ?? []), { message_id: msg.id, user_id: me.id, emoji }],
    }));
  },

  pinMessage: (msg, pinned) => {
    if (!ws.send("message:pin", { id: msg.id, pinned })) return;
    // Optimistic; the server's "message:pinned" broadcast (which also comes
    // back to us) confirms it or a rejected pin just leaves this as a guess.
    updateMessage(set, msg, (m) => ({ ...m, pinned_at: pinned ? new Date().toISOString() : null }));
  },

  fetchSaved: async () => {
    try {
      const msgs = await api.savedMessages();
      set({ savedIDs: new Set(msgs.map((m) => m.id)) });
    } catch {
      /* ignore */
    }
  },

  toggleSave: async (msg) => {
    const already = get().savedIDs.has(msg.id);
    try {
      if (already) {
        await api.unsaveMessage(msg.id);
        set((s) => { const next = new Set(s.savedIDs); next.delete(msg.id); return { savedIDs: next }; });
      } else {
        await api.saveMessage(msg.id);
        set((s) => ({ savedIDs: new Set(s.savedIDs).add(msg.id) }));
      }
    } catch {
      /* ignore — UI just won't reflect the toggle */
    }
  },

  sendMessage: (c, content, fileID, replyToID, opts) => {
    if (!content.trim() && !fileID) return;
    const me = useAuth.getState().me;
    if (!me) return;
    const clientID = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set({ sendError: null });
    const bucketKey = c.kind === "dm" ? c.peerID : c.groupID;
    const existing = (c.kind === "dm" ? get().messagesByDm[bucketKey] : get().messagesByGroup[bucketKey]) ?? [];
    const replyTarget = replyToID != null ? existing.find((m) => m.id === replyToID) : undefined;
    // optimistic bubble (replaced on ack)
    const optimistic: Message = {
      id: -(Date.now() * 1000 + (optimisticSequence++ % 1000)),
      sender_id: me.id,
      recipient_id: c.kind === "dm" ? c.peerID : null,
      group_id: c.kind === "group" ? c.groupID : null,
      file_id: fileID ?? null,
      content: content.trim(),
      sent_at: new Date().toISOString(),
      delivered_at: null,
      read_at: null,
      reply_to_id: replyToID ?? null,
      reply_to: replyTarget ? buildReplyPreview(replyTarget) : undefined,
      thread_root_id: opts?.threadRootID ?? null,
      is_encrypted: get().isEncrypted(c) && !opts?.poll,
      pending: true,
      failed: false,
      clientID,
      sender: {
        id: me.id,
        display_name: me.display_name,
        username: me.username,
        avatar_file_id: me.avatar_file_id,
      },
    };
    const patch = (m: Message) =>
      set((s) => {
        if (c.kind === "dm") {
          const arr = (s.messagesByDm[bucketKey] ?? []).filter((x) => x.id !== optimistic.id && x.id !== m.id);
          arr.push(m);
          arr.sort(messageOrder);
          return { messagesByDm: { ...s.messagesByDm, [bucketKey]: arr } };
        }
        const arr = (s.messagesByGroup[bucketKey] ?? []).filter((x) => x.id !== optimistic.id && x.id !== m.id);
        arr.push(m);
        arr.sort(messageOrder);
        return { messagesByGroup: { ...s.messagesByGroup, [bucketKey]: arr } };
    });
    patch(optimistic);
    const fail = () => {
      const pending = pendingAcks.get(clientID);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAcks.delete(clientID);
      }
      set((s) => {
        const markFailed = (list: Message[]) =>
          list.map((m) => (m.id === optimistic.id ? { ...m, pending: false, failed: true } : m));
        if (c.kind === "dm") {
          const arr = markFailed(s.messagesByDm[bucketKey] ?? []);
          return { messagesByDm: { ...s.messagesByDm, [bucketKey]: arr }, sendError: "Message not sent. Check your connection." };
        }
        const arr = markFailed(s.messagesByGroup[bucketKey] ?? []);
        return { messagesByGroup: { ...s.messagesByGroup, [bucketKey]: arr }, sendError: "Message not sent. Check your connection." };
      });
    };
    const timer = setTimeout(fail, 10000);
    pendingAcks.set(clientID, { patch, timer, fail });

    const basePayload = {
      client_id: clientID,
      recipient_id: c.kind === "dm" ? c.peerID : null,
      group_id: c.kind === "group" ? c.groupID : null,
      file_id: fileID ?? null,
      reply_to_id: replyToID ?? null,
      mentions: mentionedIDs(content),
      thread_root_id: opts?.threadRootID ?? null,
    };

    const text = content.trim();
    if (opts?.poll) {
      // Polls are stored readable (the server tallies them), so never encrypted.
      if (!ws.send("message:send", { ...basePayload, content: text, poll: opts.poll })) fail();
      return;
    }
    if (text && get().isEncrypted(c)) {
      const recipientIDs = c.kind === "dm"
        ? [me.id, c.peerID]
        : [me.id, ...(get().groups.find((g) => g.id === c.groupID)?.members.map((m) => m.id) ?? [])];
      // Re-checked on every send, not just when the toggle was first flipped
      // on — a recipient's only device key can go away between then and now
      // (they cleared site data, switched browsers, ...). Blocking here with
      // a clear error beats encryptForRecipients silently dropping them from
      // encKeys and the message going out anyway with no indication anyone
      // was excluded.
      usersMissingKeys(recipientIDs.filter((id) => id !== me.id)).then((missing) => {
        // Someone in the chat has never signed in on any device, so there's
        // no key to encrypt for. With encryption on only by default, send it
        // unencrypted and say so; if the user turned it on themselves, don't.
        if (missing.length > 0 && !hasExplicitE2EFlag(key(c))) {
          toast.info(
            missing.length === 1
              ? "Sent without end-to-end encryption: the other person hasn't signed in on any device yet."
              : `Sent without end-to-end encryption: ${missing.length} people haven't signed in on any device yet.`,
          );
          if (!ws.send("message:send", { ...basePayload, content: text })) fail();
          return;
        }
        if (missing.length > 0) {
          set({ sendError: `Could not send: ${missing.length === 1 ? "a recipient hasn't" : `${missing.length} recipients haven't`} set up encryption on any device yet.` });
          fail();
          return;
        }
        encryptForRecipients(text, recipientIDs)
          .then(({ ciphertext, iv, encKeys }) => {
            if (!ws.send("message:send", { ...basePayload, content: ciphertext, encrypted: true, enc_iv: iv, enc_keys: encKeys })) fail();
          })
          .catch(() => {
            set({ sendError: "Could not encrypt message — the recipient may not have encryption set up yet." });
            fail();
          });
      }).catch(() => {
        set({ sendError: "Could not verify recipients' encryption keys — message not sent." });
        fail();
      });
      return;
    }
    if (!ws.send("message:send", { ...basePayload, content: text })) {
      fail();
    }
  },

  retryMessage: (msg: Message) => {
    const convo: Convo | null = msg.recipient_id ? { kind: "dm", peerID: msg.recipient_id } : msg.group_id ? { kind: "group", groupID: msg.group_id } : null;
    if (!convo) return;
    const bucketKey = convo.kind === "dm" ? convo.peerID : convo.groupID;
    // remove the failed optimistic message and re-send
    set((s) => {
      if (convo.kind === "dm") {
        return { messagesByDm: { ...s.messagesByDm, [bucketKey]: (s.messagesByDm[bucketKey] ?? []).filter((m) => m.id !== msg.id) } };
      }
      return { messagesByGroup: { ...s.messagesByGroup, [bucketKey]: (s.messagesByGroup[bucketKey] ?? []).filter((m) => m.id !== msg.id) } };
    });
    get().sendMessage(convo, msg.content, msg.file_id ?? undefined, msg.reply_to_id ?? undefined, msg.thread_root_id ? { threadRootID: msg.thread_root_id } : undefined);
  },

  sendTyping: (c) => {
    const now = Date.now();
    if (now - lastTypingSent < 2500) return;
    lastTypingSent = now;
    ws.send("message:typing", {
      recipient_id: c.kind === "dm" ? c.peerID : null,
      group_id: c.kind === "group" ? c.groupID : null,
    });
  },

  markRead: (c) => {
    const k = key(c);
    if (get().unread[k]) {
      set((s) => ({ unread: { ...s.unread, [k]: 0 } }));
    }
    ws.send("message:read", {
      peer_id: c.kind === "dm" ? c.peerID : null,
      group_id: c.kind === "group" ? c.groupID : null,
    });
  },

  refreshUnread: () => { /* future REST refresh; WS pushes deltas */ },

  registerWs: () => {
    if (wsRegistered) return;
    wsRegistered = true;

    // A message that arrives while the tab is hidden stays unread (and the
    // sender gets no read receipt) until the chat is actually seen again.
    document.addEventListener("visibilitychange", () => {
      const active = get().active;
      if (!document.hidden && active && useAuth.getState().me) get().markRead(active);
    });

    ws.on("message:sent", (d) => {
      const pending = pendingAcks.get(d.client_id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAcks.delete(d.client_id);
        pending.patch(d.message as Message);
        bumpThread(set, d.message as Message);
      } else if (typeof d.client_id === "string" && d.client_id.startsWith("sync-")) {
        // Sent from another of my devices: show it here too.
        const msg = d.message as Message;
        const bucket = msg.group_id ?? msg.recipient_id;
        if (bucket != null) {
          bumpThread(set, msg);
          set((s) => {
            const field = msg.group_id != null ? "messagesByGroup" : "messagesByDm";
            const arr = [...(s[field][bucket] ?? []).filter((m) => m.id !== msg.id), msg].sort(messageOrder);
            return { [field]: { ...s[field], [bucket]: arr } } as Partial<ChatsState>;
          });
        }
      }
      get().decryptPending([d.message as Message]);
    });

    ws.on("poll:updated", (d) => {
      const ref = { id: d.message_id as number, sender_id: d.sender_id as number, recipient_id: d.recipient_id ?? null, group_id: d.group_id ?? null };
      updateMessage(set, ref, (m) => ({ ...m, poll: d.poll }));
    });
    ws.on("blocks:changed", () => {
      void get().fetchBlocked();
    });
    ws.on("group:changed", () => {
      void get().fetchGroups();
    });
    ws.on("conversation:prefs", (d) => {
      const p = d as ConvoPref;
      set((s) => ({ convoPrefs: { ...s.convoPrefs, [p.kind === "dm" ? `dm:${p.target_id}` : `g:${p.target_id}`]: p } }));
    });
    ws.on("message:group-read", (d) => {
      const gid = d.group_id as number;
      set((s) => ({
        groupReads: { ...s.groupReads, [gid]: { ...(s.groupReads[gid] ?? {}), [d.from as number]: d.last_read_id as number } },
      }));
    });

    ws.on("error", (d) => {
      if (d?.client_id) pendingAcks.get(d.client_id)?.fail();
    });

    ws.on("message:new", (d) => {
      const msg = d.message as Message;
      const me = useAuth.getState().me;
      if (!me) return;
      let convo: Convo | null = null;
      if (msg.recipient_id === me.id && msg.sender_id) {
        convo = { kind: "dm", peerID: msg.sender_id };
      } else if (msg.group_id) {
        convo = { kind: "group", groupID: msg.group_id };
      }
      if (!convo) return;
      const bucketKey = convo.kind === "dm" ? convo.peerID : convo.groupID;
      const existed = ((convo.kind === "dm" ? get().messagesByDm[bucketKey] : get().messagesByGroup[bucketKey]) ?? []).some((m) => m.id === msg.id);
      set((s) => {
      if (convo!.kind === "dm") {
          const arr = [...(s.messagesByDm[bucketKey] ?? []).filter((m) => m.id !== msg.id), msg].sort(messageOrder);
          return { messagesByDm: { ...s.messagesByDm, [bucketKey]: arr } };
        }
        const arr = [...(s.messagesByGroup[bucketKey] ?? []).filter((m) => m.id !== msg.id), msg].sort(messageOrder);
        return { messagesByGroup: { ...s.messagesByGroup, [bucketKey]: arr } };
      });
      get().decryptPending([msg]);
      if (!existed) bumpThread(set, msg);
      // unread badge unless viewing this convo and page visible
      const active = get().active;
      const isActive =
        !get().callCovering &&
        active &&
        ((convo.kind === "dm" && active.kind === "dm" && active.peerID === convo.peerID) ||
          (convo.kind === "group" && active.kind === "group" && active.groupID === convo.groupID));
      if (!isActive || document.hidden) {
        const k = key(convo);
        set((s) => ({ unread: { ...s.unread, [k]: (s.unread[k] ?? 0) + 1 } }));
        const group = get().groups.find((g) => g.id === msg.group_id);
        const from = msg.sender?.display_name ?? "New message";
        // Encrypted content can't be scanned for a mention without first
        // decrypting it (async) — notifications for encrypted messages skip
        // the "mentioned you" framing rather than block on that.
        const mentioned = !!msg.mentions?.includes(me.id) || (!msg.is_encrypted && isMentioned(msg.content, me.username));
        const muted = !!get().convoPrefs[k]?.muted && !mentioned;
        const title = mentioned
          ? `${from} mentioned you${group ? ` in ${group.name}` : ""}`
          : group
            ? `${from} in ${group.name}`
            : from;
        // Do Not Disturb still tracks unread counts, just no popup/sound.
        if (usePresence.getState().myStatus !== "dnd" && !muted) {
          const body = msg.is_encrypted ? "Encrypted message" : msg.file && !msg.content ? `Attachment: ${msg.file.name}` : msg.content;
          const c = convo;
          notify(title, body, {
            tag: k,
            onClick: () => {
              window.location.hash = "chats";
              if (c.kind === "dm") get().openDm(c.peerID);
              else get().openGroup(c.groupID);
            },
          });
        }
      }
      if (isActive && !document.hidden) {
        get().markRead(convo);
      }
    });

    ws.on("message:deleted", (d) => {
      markDeleted(set, {
        id: d.id,
        sender_id: d.sender_id,
        recipient_id: d.recipient_id ?? null,
        group_id: d.group_id ?? null,
      });
    });

    ws.on("message:edited", (d) => {
      const msg = d.message as Message;
      updateMessage(set, msg, () => msg);
    });

    ws.on("message:pinned", (d) => {
      const ref = { id: d.id as number, sender_id: d.sender_id as number, recipient_id: d.recipient_id ?? null, group_id: d.group_id ?? null };
      updateMessage(set, ref, (m) => ({ ...m, pinned_at: (d.pinned_at as string | null) ?? null }));
    });

    ws.on("message:reaction", (d) => {
      const ref = { id: d.id as number, sender_id: d.sender_id as number, recipient_id: d.recipient_id ?? null, group_id: d.group_id ?? null };
      updateMessage(set, ref, (m) => {
        const without = (m.reactions ?? []).filter((r) => !(r.user_id === d.user_id && r.emoji === d.emoji));
        return { ...m, reactions: d.added ? [...without, { message_id: m.id, user_id: d.user_id, emoji: d.emoji }] : without };
      });
    });

    ws.on("message:typing", (d) => {
      const from = d.from as number;
      const name = (d.from_name as string) || "Someone";
      if (d.group_id) {
        set((s) => ({
          typingGroup: {
            ...s.typingGroup,
            [d.group_id]: { ...(s.typingGroup[d.group_id] ?? {}), [from]: { name, time: Date.now() } },
          },
        }));
      } else {
        set((s) => ({ typingDm: { ...s.typingDm, [from]: Date.now() } }));
      }
    });

    ws.on("message:read", (d) => {
      const from = d.from as number;
      const me = useAuth.getState().me;
      if (!me) return;
      // mark my DM messages to that peer as read
      set((s) => {
        const arr = (s.messagesByDm[from] ?? []).map((m) =>
          m.sender_id === me.id && m.recipient_id === from && !m.read_at
            ? { ...m, read_at: new Date().toISOString() }
            : m,
        );
        return { messagesByDm: { ...s.messagesByDm, [from]: arr } };
      });
    });

    ws.on("message:unread", (d) => {
      const counts = (d.counts ?? {}) as Record<string, number>;
      const groupCounts = (d.group_counts ?? {}) as Record<string, number>;
      const unread: Record<string, number> = {};
      for (const [peer, n] of Object.entries(counts)) unread[`dm:${peer}`] = n;
      for (const [gid, n] of Object.entries(groupCounts)) unread[`g:${gid}`] = n;
      set({ unread });
    });
  },
}));

const pendingAcks = new Map<string, { patch: (m: Message) => void; timer: ReturnType<typeof setTimeout>; fail: () => void }>();

