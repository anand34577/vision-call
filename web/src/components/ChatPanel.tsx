import AttachmentPreview from "./AttachmentPreview";
import React, { ClipboardEvent, DragEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  BarChart3,
  Ban,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  File as FileIcon,
  Loader2,
  LogOut,
  Download,
  Forward,
  Lock,
  LockOpen,
  Mic,
  MessageSquare,
  MoreVertical,
  Paperclip,
  Pencil,
  Phone,
  Pin,
  PinOff,
  Reply as ReplyIcon,
  RotateCcw,
  Search,
  Send,
  SmilePlus,
  Square,
  Star,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  Video,
  AlertCircle,
  X,
} from "lucide-react";
import { useAuth } from "../store/auth";
import { useDirectory } from "../store/directory";
import { useChats } from "../store/chats";
import { useCalls } from "../store/calls";
import { api } from "../lib/api";
import { Avatar, Modal, PresenceDot, btnDestructive, btnGhost, btnPrimary, btnSecondary, inputCls } from "./ui";
import { fmtBytes, fmtDay, fmtTime, presenceLabel } from "../lib/util";
import { usersMissingKeys } from "../lib/crypto";
import { exportChat } from "../lib/exportChat";
import { PollCard } from "./PollCard";
import PollComposer from "./PollComposer";
import ThreadModal from "./ThreadModal";
import type { Convo, Message } from "../lib/types";

// Note: a fixed quick-reaction bar instead of a full emoji picker —
// covers the common case with zero new dependencies. Add a picker later if
// people actually ask for more than these.
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Per-conversation draft text, persisted in localStorage so switching chats
// (or reloading the tab) doesn't discard a half-written message.
function draftKey(conversationKey: string) {
  return `vc.draft.${conversationKey}`;
}
function loadDraft(conversationKey: string): string {
  try {
    return localStorage.getItem(draftKey(conversationKey)) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(conversationKey: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(draftKey(conversationKey), text);
    else localStorage.removeItem(draftKey(conversationKey));
  } catch {
    /* localStorage unavailable (private mode, quota) — drafts just don't persist */
  }
}

// mentionRegex matches "@username"-shaped tokens (not full validation — just
// enough to pick out candidates worth checking against the directory).
const mentionRegex = /(@[a-zA-Z0-9._-]{2,32})/g;

function FormattedContent({ content, knownUsernames, myUsername }: { content: string; knownUsernames: Set<string>; myUsername: string }) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = content.split(urlRegex);

  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((part, i) => {
        if (part.match(urlRegex)) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 break-all text-sky-400 hover:text-sky-300 dark:text-sky-300 dark:hover:text-sky-200"
              onClick={(e) => e.stopPropagation()}
            >
              {part}
            </a>
          );
        }
        // Split further on @mentions, highlighting any that match a real
        // username (a real mention) — bolder still if it's mine.
        const bits = part.split(mentionRegex);
        return bits.map((bit, j) => {
          if (bit.startsWith("@") && knownUsernames.has(bit.slice(1).toLowerCase())) {
            const isMe = bit.slice(1).toLowerCase() === myUsername.toLowerCase();
            return (
              <span
                key={`${i}-${j}`}
                className={`font-semibold rounded px-0.5 ${isMe ? "bg-amber-300/40 dark:bg-amber-500/30" : "bg-white/20 dark:bg-white/10"}`}
              >
                {bit}
              </span>
            );
          }
          return <React.Fragment key={`${i}-${j}`}>{bit}</React.Fragment>;
        });
      })}
    </p>
  );
}

// EncryptedContent shows the decrypted plaintext once the store's async
// decrypt finishes, a lock placeholder while it's in flight, or a clear
// "not on this device" message when this device has no key for it (sent
// before this device registered, or from a browser profile that's gone).
function EncryptedContent({ m, knownUsernames, myUsername }: { m: Message; knownUsernames: Set<string>; myUsername: string }) {
  const decrypted = useChats((s) => s.decryptedContent[m.id]);
  return (
    <div className="flex items-start gap-1.5">
      <Lock className="h-3 w-3 mt-1 shrink-0 opacity-60" />
      {decrypted === undefined ? (
        <p className="italic opacity-70">Decrypting…</p>
      ) : decrypted === null ? (
        <p className="italic opacity-70">Encrypted message (not available on this device)</p>
      ) : (
        <FormattedContent content={decrypted} knownUsernames={knownUsernames} myUsername={myUsername} />
      )}
    </div>
  );
}

function Ticks({ msg }: { msg: Message }) {
  if (msg.read_at) return <CheckCheck className="h-4 w-4 text-sky-500" aria-label="Read" role="img" />;
  if (msg.delivered_at) return <CheckCheck className="h-4 w-4 text-zinc-400" aria-label="Delivered" role="img" />;
  return <Check className="h-4 w-4 text-zinc-400" aria-label="Sent" role="img" />;
}

// GroupSeen shows who has read one of my group messages (from each member's
// last-read marker) instead of a single delivered/read tick.
function GroupSeen({ msg, group, meID, reads }: { msg: Message; group: { members: { id: number; display_name: string }[] }; meID: number; reads?: Record<number, number> }) {
  const seenBy = group.members.filter((mem) => mem.id !== meID && (reads?.[mem.id] ?? 0) >= msg.id);
  if (seenBy.length === 0) return <Check className="h-4 w-4 text-zinc-400" aria-label="Sent" role="img" />;
  const names = seenBy.map((x) => x.display_name).join(", ");
  return (
    <span className="inline-flex items-center gap-0.5" title={`Seen by ${names}`}>
      <CheckCheck className="h-4 w-4 text-sky-500" aria-label={`Seen by ${names}`} role="img" />
      <span>{seenBy.length}</span>
    </span>
  );
}

// canActOn gates reply/react/edit/delete on a message that's fully landed —
// not deleted, not still an optimistic/failed local echo (those have no
// server-assigned id yet, so a reply/reaction would have nothing real to
// attach to).
function canActOn(m: Message): boolean {
  return !m.deleted_at && !m.pending && !m.failed && m.id > 0;
}

// canPin mirrors the server's signaling.canPin: message sender, a site
// admin, a group owner/admin for a group message, or either party of a DM.
function canPin(m: Message, meID: number, meSiteAdmin: boolean, group?: { members: { id: number; role: string }[] }): boolean {
  if (m.sender_id === meID || meSiteAdmin) return true;
  if (group) {
    const myRole = group.members.find((x) => x.id === meID)?.role;
    return myRole === "owner" || myRole === "admin";
  }
  return m.recipient_id === meID;
}

function MessageActions({
  m,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onForward,
  onSave,
  saved,
  onThread,
  showReactionPicker,
  onPickReaction,
  align,
}: {
  m: Message;
  onReply: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onReact: () => void;
  onPin?: () => void;
  onForward?: () => void;
  onSave?: () => void;
  saved?: boolean;
  onThread?: () => void;
  showReactionPicker: boolean;
  onPickReaction: (emoji: string) => void;
  align: "left" | "right";
}) {
  return (
    <div className="relative shrink-0">
      <div className="opacity-100 max-md:opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition flex items-center gap-0.5">
        <button
          onClick={onReact}
          title="React"
          aria-label="Add reaction"
          className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40"
        >
          <SmilePlus className="h-4 w-4" />
        </button>
        <button
          onClick={onReply}
          title="Reply"
          aria-label="Reply"
          className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
        >
          <ReplyIcon className="h-4 w-4" />
        </button>
        {onThread && (
          <button
            onClick={onThread}
            title="Reply in thread"
            aria-label="Reply in thread"
            className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        )}
        {onEdit && (
          <button
            onClick={onEdit}
            title="Edit"
            aria-label="Edit message"
            className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Pencil className="h-4 w-4" />
          </button>
        )}
        {onSave && (
          <button
            onClick={onSave}
            title={saved ? "Remove from saved" : "Save message"}
            aria-label={saved ? "Remove from saved" : "Save message"}
            aria-pressed={!!saved}
            className={`h-9 w-9 rounded-full flex items-center justify-center hover:bg-amber-50 dark:hover:bg-amber-950/40 ${saved ? "text-amber-500" : "text-zinc-500 dark:text-zinc-400 hover:text-amber-600"}`}
          >
            <Star className="h-4 w-4" fill={saved ? "currentColor" : "none"} />
          </button>
        )}
        {onForward && (
          <button
            onClick={onForward}
            title="Forward message"
            aria-label="Forward message"
            className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
          >
            <Forward className="h-4 w-4" />
          </button>
        )}
        {onPin && (
          <button
            onClick={onPin}
            title={m.pinned_at ? "Unpin message" : "Pin message"}
            aria-label={m.pinned_at ? "Unpin message" : "Pin message"}
            aria-pressed={!!m.pinned_at}
            className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/40"
          >
            {m.pinned_at ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            title="Delete message"
            aria-label="Delete message"
            className="h-9 w-9 rounded-full flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {showReactionPicker && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => onPickReaction("")} onKeyDown={(e) => { if (e.key === "Escape") onPickReaction(""); }} />
          <div
            role="menu"
            aria-label="Choose a reaction"
            className={`absolute top-10 z-20 flex items-center gap-1 bg-surface border border-line text-ink rounded-full px-2.5 py-1.5 shadow-2xl animate-modal-in ${align === "right" ? "right-0" : "left-0"}`}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => onPickReaction(emoji)}
                className="h-9 w-9 rounded-full hover:bg-surface-hover flex items-center justify-center text-lg transition-transform hover:scale-125 active:scale-95 cursor-pointer"
                aria-label={`React with ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        </>
      )}
      <span className="sr-only">{m.id}</span>
    </div>
  );
}

function ReactionPills({
  reactions,
  meID,
  mine,
  onToggle,
}: {
  reactions: NonNullable<Message["reactions"]>;
  meID: number;
  mine: boolean;
  onToggle: (emoji: string) => void;
}) {
  const counts = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const cur = counts.get(r.emoji) ?? { count: 0, mine: false };
    cur.count++;
    if (r.user_id === meID) cur.mine = true;
    counts.set(r.emoji, cur);
  }
  return (
    <div className={`flex flex-wrap gap-1 mt-1 ${mine ? "justify-end" : "justify-start"}`}>
      {Array.from(counts.entries()).map(([emoji, { count, mine: iReacted }]) => (
        <button
          key={emoji}
          onClick={() => onToggle(emoji)}
          className={`text-xs rounded-full px-1.5 py-0.5 border flex items-center gap-1 transition ${
            iReacted
              ? "bg-indigo-50 dark:bg-indigo-500/10 border-indigo-300 dark:border-indigo-700"
              : "bg-zinc-800 border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600"
          }`}
        >
          <span>{emoji}</span>
          <span className="text-[10px] text-zinc-500 text-zinc-400">{count}</span>
        </button>
      ))}
    </div>
  );
}

export default function ChatPanel({ onBack }: { onBack: () => void }) {
  const me = useAuth((s) => s.me)!;
  const {
    active,
    groups,
    typingDm,
    typingGroup,
    messagesByDm,
    messagesByGroup,
    sendMessage,
    retryMessage,
    deleteMessage,
    editMessage,
    reactToMessage,
    pinMessage,
    savedIDs,
    toggleSave,
    isEncrypted,
    setEncrypted,
    deleteGroup,
    renameGroup,
    updateGroup,
    setGroupMemberRole,
    addGroupMembers,
    removeGroupMember,
    sendTyping,
    loadMessages,
    hasMore,
    historyLoading,
    sendError,
    clearSendError,
    convoPrefs,
    setConvoPref,
    groupReads,
    fetchGroupReads,
    blocked,
    setBlocked,
  } = useChats();
  const directoryUsers = useDirectory((s) => s.users);
  const startDmCall = useCalls((s) => s.startDmCall);
  const startGroupCall = useCalls((s) => s.startGroupCall);

  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [topicBusy, setTopicBusy] = useState(false);
  const [groupAvatarBusy, setGroupAvatarBusy] = useState(false);
  const [encryptBusy, setEncryptBusy] = useState(false);
  const [roleBusyID, setRoleBusyID] = useState<number | null>(null);
  const groupFileInput = useRef<HTMLInputElement>(null);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [newMemberIDs, setNewMemberIDs] = useState<number[]>([]);
  const [addingMembers, setAddingMembers] = useState(false);
  const [removingMemberID, setRemovingMemberID] = useState<number | null>(null);
  const [pendingRemoveID, setPendingRemoveID] = useState<number | null>(null);
  const [leavingGroup, setLeavingGroup] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState(false);
  const [groupActionError, setGroupActionError] = useState<string | null>(null);
  const [deleteMsgConfirm, setDeleteMsgConfirm] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingID, setEditingID] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [reactionPickerFor, setReactionPickerFor] = useState<number | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null);
  const [forwardSearch, setForwardSearch] = useState("");
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastCountRef = useRef(0);
  const preserveScrollRef = useRef<{ top: number; height: number } | null>(null);
  const prevConversationKeyRef = useRef("");
  const textRef = useRef("");
  textRef.current = text;

  const isDM = active?.kind === "dm";
  const peer = useDirectory((s) => (isDM ? s.users.find((u) => u.id === (active as any).peerID) : undefined));
  const group = isDM ? undefined : groups.find((g) => g.id === active?.groupID);
  // Replies inside a thread live in the thread window, not the main timeline.
  const messages = (active ? (isDM ? messagesByDm[(active as any).peerID] : messagesByGroup[active!.groupID]) ?? [] : []).filter((m) => !m.thread_root_id);
  const conversationKey = active ? (isDM ? `dm:${(active as any).peerID}` : `g:${active.groupID}`) : "";
  // Note: derived from whatever's already loaded rather than a separate
  // fetch — a pinned message outside the currently-loaded page won't show
  // here until you scroll up to load it. Good enough; add a dedicated
  // fetch (api.pinnedMessages) if that gap actually bites someone.
  const pinnedMessages = messages.filter((m) => m.pinned_at && !m.deleted_at).sort((a, b) => (b.pinned_at! > a.pinned_at! ? 1 : -1));
  const [showPinned, setShowPinned] = useState(false);
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [showPoll, setShowPoll] = useState(false);
  const [blockConfirm, setBlockConfirm] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const peerBlocked = isDM && !!peer && blocked.includes(peer.id);
  const toggleBlock = async () => {
    if (!peer) return;
    setBlockBusy(true);
    try {
      await setBlocked(peer.id, !peerBlocked);
      setBlockConfirm(false);
    } catch (err: any) {
      setUploadError(err?.message ?? "Could not update block");
    }
    setBlockBusy(false);
  };
  const groupModerator = !!group && (me.role === "admin" || ["owner", "admin"].includes(group.members.find((x) => x.id === me.id)?.role ?? ""));
  const convoPref = active ? convoPrefs[conversationKey] : undefined;
  const muted = !!convoPref?.muted;
  const archived = !!convoPref?.archived;
  const groupID = group?.id;
  useEffect(() => {
    if (groupID != null) void fetchGroupReads(groupID);
  }, [groupID, fetchGroupReads]);
  const prefButtons = active ? (
    <>
      <button
        onClick={() => void setConvoPref(active, { muted: !muted })}
        title={muted ? "Unmute notifications" : "Mute notifications"}
        aria-label={muted ? "Unmute notifications" : "Mute notifications"}
        aria-pressed={muted}
        className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition cursor-pointer"
      >
        {muted ? <BellOff className="h-4 w-4 text-amber-500" /> : <Bell className="h-4 w-4" />}
      </button>
      <button
        onClick={() => { void setConvoPref(active, { archived: !archived }); if (!archived) onBack(); }}
        title={archived ? "Move back to chats" : "Archive chat"}
        aria-label={archived ? "Unarchive chat" : "Archive chat"}
        aria-pressed={archived}
        className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition cursor-pointer"
      >
        <Archive className={`h-4 w-4 ${archived ? "text-blue-500" : ""}`} />
      </button>
    </>
  ) : null;
  const [exporting, setExporting] = useState(false);
  const exportButton = active ? (
    <button
      onClick={() => {
        setExporting(true);
        exportChat(active, isDM ? (peer?.username ?? "dm") : (group?.name ?? "group"))
          .catch(() => setUploadError("Could not export this conversation"))
          .finally(() => setExporting(false));
      }}
      disabled={exporting}
      title="Export conversation (readable text file)"
      aria-label="Export conversation"
      className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition cursor-pointer"
    >
      {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
    </button>
  ) : null;
  const knownUsernames = new Set(directoryUsers.map((u) => u.username.toLowerCase()));
  const encrypted = active ? isEncrypted(active) : false;

  const toggleEncryption = async () => {
    if (!active) return;
    if (encrypted) {
      setEncrypted(active, false);
      return;
    }
    setEncryptBusy(true);
    setUploadError(null);
    try {
      const targetIDs = isDM ? [(active as any).peerID] : (group?.members.map((m) => m.id) ?? []);
      const missing = await usersMissingKeys(targetIDs);
      if (missing.length > 0) {
        const names = missing
          .map((id) => (isDM ? peer?.display_name : group?.members.find((m) => m.id === id)?.display_name) ?? `#${id}`)
          .join(", ");
        setUploadError(`Can't enable encryption yet — ${names} hasn't opened the app on a device with encryption set up.`);
      } else {
        setEncrypted(active, true);
      }
    } catch {
      setUploadError("Could not check encryption readiness");
    }
    setEncryptBusy(false);
  };

  // Typing status calculation
  let typingText = "";
  if (isDM) {
    const ts = typingDm[(active as any)?.peerID];
    if (ts && Date.now() - ts < 4000) {
      typingText = `${peer?.display_name ?? "Peer"} is typing…`;
    }
  } else if (active && typingGroup[active.groupID]) {
    const activeTypers = Object.values(typingGroup[active.groupID])
      .filter((t) => Date.now() - t.time < 4000)
      .map((t) => t.name);
    if (activeTypers.length === 1) {
      typingText = `${activeTypers[0]} is typing…`;
    } else if (activeTypers.length > 1) {
      typingText = `${activeTypers.join(", ")} are typing…`;
    }
  }

  // Re-render only while someone is actively typing (lets the indicator expire).
  const [, force] = useState(0);
  useEffect(() => {
    if (!typingText) return;
    const t = setInterval(() => force((n) => n + 1), 2500);
    return () => clearInterval(t);
  }, [typingText]);

  useEffect(() => {
    // Save whatever was typed in the conversation we're leaving as a draft,
    // then restore any draft for the one we're entering — switching chats
    // to check something shouldn't lose a half-written message.
    if (prevConversationKeyRef.current && prevConversationKeyRef.current !== conversationKey) {
      saveDraft(prevConversationKeyRef.current, textRef.current);
    }
    prevConversationKeyRef.current = conversationKey;

    lastCountRef.current = 0;
    preserveScrollRef.current = null;
    setUploadError(null);
    clearSendError();
    setText(conversationKey ? loadDraft(conversationKey) : "");
    setReplyTo(null);
    setEditingID(null);
    setReactionPickerFor(null);
    setShowPinned(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [conversationKey, clearSendError]);

  // autoscroll on new messages
  useEffect(() => {
    if (messages.length !== lastCountRef.current) {
      const el = scrollRef.current;
      if (el && preserveScrollRef.current) {
        const previous = preserveScrollRef.current;
        el.scrollTop = previous.top + (el.scrollHeight - previous.height);
        preserveScrollRef.current = null;
      } else if (el) {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (lastCountRef.current === 0 || distanceFromBottom < 120) {
          el.scrollTop = el.scrollHeight;
        }
      }
      lastCountRef.current = messages.length;
    }
  }, [messages.length]);

  // @mention autocomplete: candidates are the peer or the group's members.
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionCandidates = mention
    ? (isDM ? (peer ? [peer] : []) : (group?.members ?? []))
        .filter((u) => u.id !== me.id)
        .filter((u) => u.username.toLowerCase().includes(mention.q.toLowerCase()) || u.display_name.toLowerCase().includes(mention.q.toLowerCase()))
        .slice(0, 6)
    : [];
  const pickMention = (username: string) => {
    if (!mention) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${username} ${text.slice(caret)}`;
    setText(next);
    if (conversationKey) saveDraft(conversationKey, next);
    setMention(null);
    const pos = mention.start + username.length + 2;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  };

  // Voice messages: record with the microphone, upload as an audio file.
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: ReturnType<typeof setInterval>; send: boolean } | null>(null);
  const canRecord = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const startRecording = async () => {
    if (!canRecord || recRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
      const timer = setInterval(() => setRecSecs((n) => n + 1), 1000);
      recRef.current = { rec, stream, chunks, timer, send: true };
      rec.onstop = async () => {
        const cur = recRef.current;
        recRef.current = null;
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        if (!cur || !cur.send || !cur.chunks.length || !active) return;
        const type = rec.mimeType || "audio/webm";
        const file = new File(cur.chunks, `voice-message-${Date.now()}.${type.includes("mp4") ? "m4a" : "webm"}`, { type });
        setUploading(true);
        try {
          const f = await api.uploadFile(file);
          sendMessage(active, "", f.id, replyTo?.id);
          setReplyTo(null);
        } catch (err: any) {
          setUploadError(err?.message ?? "Could not send voice message");
        }
        setUploading(false);
      };
      setRecSecs(0);
      setRecording(true);
      rec.start();
    } catch {
      setUploadError("Microphone unavailable — check the browser's permission.");
    }
  };
  const stopRecording = (send: boolean) => {
    const cur = recRef.current;
    if (!cur) return;
    cur.send = send;
    cur.rec.stop();
  };
  useEffect(() => () => { if (recRef.current) { recRef.current.send = false; recRef.current.rec.stop(); } }, []);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const caret = e.target.selectionStart ?? e.target.value.length;
    const m = /(^|\s)@([a-zA-Z0-9._-]{0,32})$/.exec(e.target.value.slice(0, caret));
    setMention(m ? { q: m[2], start: caret - m[2].length - 1 } : null);
    setMentionIdx(0);
    setText(e.target.value);
    if (conversationKey) saveDraft(conversationKey, e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
  };

  const send = () => {
    if (!active || !text.trim()) return;
    sendMessage(active, text, undefined, replyTo?.id);
    setText("");
    saveDraft(conversationKey, "");
    setReplyTo(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const startEdit = (m: Message) => {
    setEditingID(m.id);
    setEditDraft(m.content);
    setReplyTo(null);
  };

  const saveEdit = (m: Message) => {
    const content = editDraft.trim();
    if (content && content !== m.content) editMessage(m, content);
    setEditingID(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = mentionCandidates.length;
        setMentionIdx((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i + n - 1) % n));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionCandidates[Math.min(mentionIdx, mentionCandidates.length - 1)].username);
        return;
      }
      if (e.key === "Escape") { setMention(null); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (active && text.trim()) {
      sendTyping(active);
    }
  };

  // Picked, dropped or pasted files wait in a preview (with a caption)
  // until the user presses Send.
  const [staged, setStaged] = useState<File[]>([]);
  const [sendProgress, setSendProgress] = useState<number | null>(null);
  const stageFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length) setStaged((s) => [...s, ...list]);
  };

  // Uploads one at a time: parallel uploads would race the per-user storage
  // quota check, which reads then writes. The caption goes with the first file.
  const sendStaged = async (caption: string) => {
    const target = active;
    const list = staged;
    if (!target || list.length === 0) return;
    setUploading(true);
    setUploadError(null);
    setSendProgress(0);
    let failures = 0;
    let lastError = "";
    for (let i = 0; i < list.length; i++) {
      try {
        const f = await api.uploadFile(list[i], (p) => setSendProgress((i + p) / list.length));
        sendMessage(target, i === 0 ? caption : "", f.id, i === 0 ? replyTo?.id : undefined);
      } catch (err: any) {
        failures++;
        lastError = err?.message ?? "Could not upload file";
      }
    }
    setReplyTo(null);
    setStaged([]);
    setSendProgress(null);
    setUploading(false);
    if (failures > 0) setUploadError(list.length === 1 ? lastError : `${failures} of ${list.length} files failed to upload`);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          stageFiles([file]);
          return;
        }
      }
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      stageFiles(e.dataTransfer.files);
    }
  };

  const handleDeleteGroup = async () => {
    if (!group) return;
    setDeletingGroup(true);
    try {
      await deleteGroup(group.id);
      setShowGroupInfo(false);
      onBack();
    } catch (err: any) {
      setUploadError(err?.message ?? "Could not delete group");
    }
    setDeletingGroup(false);
  };

  const isGroupOwner = !!group && (group.created_by === me.id || me.role === "admin");
  const myGroupRole = group?.members.find((m) => m.id === me.id)?.role;
  const canManageGroup = isGroupOwner || myGroupRole === "admin";

  const startRename = () => {
    if (!group) return;
    setNameDraft(group.name);
    setGroupActionError(null);
    setEditingName(true);
  };

  const saveRename = async () => {
    if (!group) return;
    const name = nameDraft.trim();
    if (!name || name === group.name) {
      setEditingName(false);
      return;
    }
    setRenamingBusy(true);
    setGroupActionError(null);
    try {
      await renameGroup(group.id, name);
      setEditingName(false);
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not rename group");
    }
    setRenamingBusy(false);
  };

  const startTopicEdit = () => {
    if (!group) return;
    setTopicDraft(group.topic);
    setGroupActionError(null);
    setEditingTopic(true);
  };

  const saveTopic = async () => {
    if (!group) return;
    setTopicBusy(true);
    try {
      await updateGroup(group.id, { topic: topicDraft.trim() });
      setEditingTopic(false);
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not update topic");
    }
    setTopicBusy(false);
  };

  const uploadGroupAvatar = async (file: File) => {
    if (!group) return;
    setGroupAvatarBusy(true);
    setGroupActionError(null);
    try {
      const f = await api.uploadFile(file);
      await updateGroup(group.id, { avatar_file_id: f.id });
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not update group icon");
    }
    setGroupAvatarBusy(false);
  };

  const removeGroupAvatar = async () => {
    if (!group) return;
    setGroupAvatarBusy(true);
    setGroupActionError(null);
    try {
      await updateGroup(group.id, { avatar_file_id: 0 });
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not remove group icon");
    }
    setGroupAvatarBusy(false);
  };

  const toggleMemberRole = async (m: { id: number; role: string }) => {
    if (!group) return;
    setRoleBusyID(m.id);
    setGroupActionError(null);
    try {
      await setGroupMemberRole(group.id, m.id, m.role === "admin" ? "member" : "admin");
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not update role");
    }
    setRoleBusyID(null);
  };

  const forwardTo = (target: Convo) => {
    if (!forwardingMsg) return;
    // forwardingMsg.content is ciphertext for an encrypted message, not the
    // plaintext — the forward button is hidden for encrypted messages, but
    // guard here too so this can never ship ciphertext into a conversation
    // that isn't its own, even if a future caller reuses forwardTo without
    // that guard.
    if (forwardingMsg.is_encrypted) {
      setForwardingMsg(null);
      setForwardSearch("");
      return;
    }
    sendMessage(target, forwardingMsg.content);
    setForwardingMsg(null);
    setForwardSearch("");
  };

  const handleAddMembers = async () => {
    if (!group || newMemberIDs.length === 0) return;
    setAddingMembers(true);
    setGroupActionError(null);
    try {
      await addGroupMembers(group.id, newMemberIDs);
      setNewMemberIDs([]);
      setMemberSearch("");
      setShowAddMembers(false);
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not add members");
    }
    setAddingMembers(false);
  };

  const handleRemoveMember = async (userID: number) => {
    if (!group) return;
    setPendingRemoveID(null);
    setRemovingMemberID(userID);
    setGroupActionError(null);
    try {
      await removeGroupMember(group.id, userID);
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not remove member");
    }
    setRemovingMemberID(null);
  };

  const handleLeaveGroup = async () => {
    if (!group) return;
    setLeavingGroup(true);
    setGroupActionError(null);
    try {
      await removeGroupMember(group.id, me.id);
      setShowGroupInfo(false);
      onBack();
    } catch (err: any) {
      setGroupActionError(err?.message ?? "Could not leave group");
      setLeavingGroup(false);
    }
  };

  const addableUsers = directoryUsers.filter(
    (u) =>
      u.id !== me.id &&
      !u.disabled &&
      !group?.members.some((m) => m.id === u.id) &&
      (memberSearch
        ? u.display_name.toLowerCase().includes(memberSearch.toLowerCase()) ||
          u.username.toLowerCase().includes(memberSearch.toLowerCase())
        : true),
  );

  let lastDay = "";

  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-white dark:bg-zinc-950 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-30 bg-blue-600/20 backdrop-blur-sm border-2 border-dashed border-indigo-500 rounded-xl flex items-center justify-center pointer-events-none">
          <div className="bg-zinc-900 px-6 py-4 rounded-2xl shadow-xl flex items-center gap-3">
            <Paperclip className="h-6 w-6 text-blue-400 animate-bounce" />
            <p className="font-semibold text-sm">Drop file to attach</p>
          </div>
        </div>
      )}

      {/* header */}
      <div className="flex items-center gap-3 px-4 sm:px-5 h-16 border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/80 backdrop-blur-xl shrink-0 z-10">
        <button className="md:hidden h-10 w-10 -ml-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft className="h-5 w-5" />
        </button>
        {isDM && peer ? (
          <>
            <div className="relative">
              <Avatar name={peer.display_name} id={peer.id} fileId={peer.avatar_file_id} size="md" />
              <span className="absolute -bottom-0.5 -right-0.5">
                <PresenceDot status={peer.status} />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100 truncate tracking-tight">{peer.display_name}</p>
              <p className="text-xs text-zinc-500 font-medium">{presenceLabel(peer.status)}{peer.status_text ? ` · ${peer.status_text}` : ""}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => peer && void startDmCall({ id: peer.id, display_name: peer.display_name, username: peer.username, avatar_file_id: peer.avatar_file_id }, false)}
                title="Voice call"
                aria-label="Start voice call"
                className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center justify-center text-zinc-500 dark:text-zinc-300 border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700/60 transition cursor-pointer"
              >
                <Phone className="h-4 w-4" />
              </button>
              <button
                onClick={() => peer && void startDmCall({ id: peer.id, display_name: peer.display_name, username: peer.username, avatar_file_id: peer.avatar_file_id }, true)}
                title="Video call"
                aria-label="Start video call"
                className="h-10 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-blue-600/25 active:scale-95 transition cursor-pointer"
              >
                <Video className="h-4 w-4" />
                <span className="hidden sm:inline">Call</span>
              </button>
              {exportButton}
              <button
                onClick={() => (peerBlocked ? void toggleBlock() : setBlockConfirm(true))}
                title={peerBlocked ? "Unblock this person" : "Block this person"}
                aria-label={peerBlocked ? "Unblock this person" : "Block this person"}
                aria-pressed={peerBlocked}
                className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-rose-600 transition cursor-pointer"
              >
                <Ban className={`h-4 w-4 ${peerBlocked ? "text-rose-500" : ""}`} />
              </button>
              {prefButtons}
              <button
                onClick={() => void toggleEncryption()}
                disabled={encryptBusy}
                title={encrypted ? "Encryption on — click to turn off" : "Turn on end-to-end encryption for this chat"}
                aria-label={encrypted ? "Turn off encryption" : "Turn on encryption"}
                aria-pressed={encrypted}
                className={`h-10 w-10 rounded-xl flex items-center justify-center transition border ${encrypted ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60" : "text-zinc-500 dark:text-zinc-400 border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-200"}`}
              >
                {encryptBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : encrypted ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
              </button>
            </div>
          </>
        ) : group ? (
          <>
            <Avatar name={group.name} id={group.id} fileId={group.avatar_file_id} size="md" />
            <button type="button" onClick={() => setShowGroupInfo(true)} className="min-w-0 flex-1 text-left rounded-lg px-1 -ml-1 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition" aria-label={`Open details for ${group.name}`}>
              <p className="font-bold text-sm text-zinc-900 dark:text-zinc-100 truncate hover:underline tracking-tight">{group.name}</p>
              <p className="text-xs text-zinc-500 font-medium truncate">
                {group.members.length} members{group.topic ? ` · ${group.topic}` : ""}
              </p>
            </button>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void startGroupCall(group)}
                title="Start group call"
                aria-label="Start group call"
                className="h-10 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-blue-600/25 active:scale-95 transition cursor-pointer"
              >
                <Video className="h-4 w-4" />
                <span className="hidden sm:inline">Call</span>
              </button>
              {exportButton}
              {prefButtons}
              <button
                onClick={() => void toggleEncryption()}
                disabled={encryptBusy}
                title={encrypted ? "Encryption on — click to turn off" : "Turn on end-to-end encryption for this group"}
                aria-label={encrypted ? "Turn off encryption" : "Turn on encryption"}
                aria-pressed={encrypted}
                className={`h-10 w-10 rounded-xl flex items-center justify-center transition border ${encrypted ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60" : "text-zinc-500 dark:text-zinc-400 border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-200"}`}
              >
                {encryptBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : encrypted ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
              </button>
              <button
                onClick={() => setShowGroupInfo(true)}
                title="Group details"
                aria-label="Open group details"
                className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800/80 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 transition cursor-pointer"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : null}
      </div>

      {pinnedMessages.length > 0 && (
        <div className="border-b border-zinc-800 bg-amber-50/60 dark:bg-amber-950/20 shrink-0">
          <button
            onClick={() => setShowPinned((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300"
          >
            <Pin className="h-3.5 w-3.5" />
            {pinnedMessages.length} pinned message{pinnedMessages.length === 1 ? "" : "s"}
          </button>
          {showPinned && (
            <div className="max-h-40 overflow-y-auto px-4 pb-2 space-y-1.5">
              {pinnedMessages.map((m) => (
                <div key={m.id} className="text-xs bg-white/70 dark:bg-black/20 rounded-lg px-2.5 py-1.5 flex items-start gap-2">
                  <span className="font-semibold text-amber-700 dark:text-amber-300 shrink-0">{m.sender?.display_name ?? "Someone"}:</span>
                  <span className="truncate flex-1 flex items-center gap-1">
                    {!m.content && m.file && <Paperclip className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{m.content || m.file?.name || ""}</span>
                  </span>
                  {canPin(m, me.id, me.role === "admin", group) && (
                    <button onClick={() => pinMessage(m, false)} className="shrink-0 text-amber-600 hover:text-amber-800" title="Unpin" aria-label="Unpin">
                      <PinOff className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
        {active && hasMore[isDM ? `dm:${(active as any).peerID}` : `g:${active.groupID}`] && (
          <div className="text-center pb-2">
            <button
              onClick={() => {
                const el = scrollRef.current;
                if (el) preserveScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
                void loadMessages(active, messages[0]?.id);
              }}
              disabled={historyLoading[isDM ? `dm:${(active as any).peerID}` : `g:${active.groupID}`]}
              className="text-xs text-indigo-500 hover:underline"
            >
              {historyLoading[isDM ? `dm:${(active as any).peerID}` : `g:${active.groupID}`] ? "Loading…" : "Load older messages"}
            </button>
          </div>
        )}
        {messages.map((m) => {
          const day = fmtDay(m.sent_at);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = m.sender_id === me.id;
          return (
            <div key={m.id} className="animate-msg-in">
              {showDay && (
                <div className="flex justify-center py-3">
                  <span className="text-[11px] font-medium text-zinc-400 bg-zinc-200/60 bg-zinc-800/60 rounded-full px-3 py-1">
                    {day}
                  </span>
                </div>
              )}
              <SwipeToReply
                enabled={canActOn(m)}
                onReply={() => { setReplyTo(m); setEditingID(null); }}
                className={`flex items-center gap-1 group ${mine ? "justify-end" : "justify-start"} ${m.pending ? "opacity-70" : ""}`}
              >
                {mine && canActOn(m) && (
                  <MessageActions
                    m={m}
                    onReply={() => { setReplyTo(m); setEditingID(null); }}
                    onEdit={m.is_encrypted ? undefined : () => startEdit(m)}
                    onDelete={() => setDeleteMsgConfirm(m)}
                    onReact={() => setReactionPickerFor(reactionPickerFor === m.id ? null : m.id)}
                    onPin={canPin(m, me.id, me.role === "admin", group) ? () => pinMessage(m, !m.pinned_at) : undefined}
                    onForward={m.content && !m.is_encrypted ? () => setForwardingMsg(m) : undefined}
                    onSave={() => void toggleSave(m)}
                    saved={savedIDs.has(m.id)}
                    onThread={() => setThreadRoot(m)}
                    showReactionPicker={reactionPickerFor === m.id}
                    onPickReaction={(emoji) => { if (emoji) reactToMessage(m, emoji); setReactionPickerFor(null); }}
                    align="right"
                  />
                )}
                <div className="max-w-[75%] min-w-0" id={`msg-${m.id}`}>
                  {m.reply_to && !m.deleted_at && (
                    <button
                      type="button"
                      onClick={() => document.getElementById(`msg-${m.reply_to!.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
                      title="Jump to replied message"
                      className={`mb-1 rounded-lg px-2.5 py-1 text-xs border-l-2 truncate w-full text-left hover:opacity-80 transition ${mine ? "border-indigo-300 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ml-auto" : "border-zinc-300 dark:border-zinc-600 bg-zinc-100 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-400"}`}
                    >
                      <span className="font-semibold">{m.reply_to.sender?.display_name ?? "Someone"}: </span>
                      {m.reply_to.deleted ? (
                        "Message deleted"
                      ) : m.reply_to.is_encrypted ? (
                        <><Lock className="inline h-3 w-3 -mt-0.5 mr-0.5" />Encrypted message</>
                      ) : m.reply_to.content ? (
                        m.reply_to.content
                      ) : m.reply_to.has_file ? (
                        <><Paperclip className="inline h-3 w-3 -mt-0.5 mr-0.5" />file</>
                      ) : (
                        ""
                      )}
                    </button>
                  )}
                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm shadow-2xs transition-all ${
                      m.deleted_at
                        ? "bg-transparent border border-dashed border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 italic"
                        : mine
                          ? m.failed
                            ? "bg-rose-600 text-white rounded-br-md shadow-sm shadow-rose-600/20"
                            : "bg-blue-600 text-white rounded-br-md shadow-md shadow-blue-600/20"
                          : "bg-zinc-100 dark:bg-[#151b28] border border-zinc-200 dark:border-white/10 text-zinc-900 dark:text-zinc-100 rounded-bl-md shadow-2xs"
                    }`}
                  >
                    {!mine && isDM === false && !m.deleted_at && (
                      <p className="text-xs font-semibold text-indigo-500 dark:text-indigo-300 mb-0.5">
                        {m.sender?.display_name}
                      </p>
                    )}
                    {m.deleted_at ? (
                      <p className="flex items-center gap-1.5">
                        <Trash2 className="h-3.5 w-3.5" />
                        Message deleted
                      </p>
                    ) : editingID === m.id ? (
                      <div className="space-y-1.5 min-w-[12rem]">
                        <textarea
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              saveEdit(m);
                            } else if (e.key === "Escape") {
                              setEditingID(null);
                            }
                          }}
                          rows={2}
                          className="w-full resize-none rounded-lg bg-white/10 dark:bg-black/20 px-2 py-1.5 text-sm outline-none border border-white/30"
                        />
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => setEditingID(null)} className="text-[10px] px-2 py-1 rounded bg-white/10 hover:bg-white/20">
                            Cancel
                          </button>
                          <button onClick={() => saveEdit(m)} className="text-[10px] px-2 py-1 rounded bg-white/20 hover:bg-white/30 font-semibold">
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {m.file && m.file.mime.startsWith("image/") && (
                          <button
                            type="button"
                            onClick={() => setLightbox({ src: `/api/files/${m.file!.id}`, name: m.file!.name })}
                            className="block rounded-lg mb-1.5 overflow-hidden focus-visible:ring-2 focus-visible:ring-blue-500"
                            aria-label={`Open image ${m.file.name}`}
                          >
                            <img
                              src={`/api/files/${m.file.id}`}
                              alt={m.file.name}
                              loading="lazy"
                              className="rounded-lg max-h-64 w-auto max-w-full object-cover hover:opacity-95 transition"
                            />
                          </button>
                        )}
                        {m.file && m.file.mime.startsWith("video/") && (
                          <video
                            src={`/api/files/${m.file.id}`}
                            controls
                            preload="metadata"
                            className="rounded-lg mb-1.5 max-h-72 w-full max-w-sm bg-black"
                          />
                        )}
                        {m.file && m.file.mime.startsWith("audio/") && (
                          <audio src={`/api/files/${m.file.id}`} controls preload="metadata" className="mb-1.5 w-64 max-w-full" />
                        )}
                        {m.file && !/^(image|video|audio)\//.test(m.file.mime) && (
                          <a
                            href={`/api/files/${m.file.id}`}
                            download={m.file.name}
                            className={`flex items-center gap-3 mb-1.5 rounded-xl px-3 py-2.5 min-w-[12rem] transition ${mine ? "bg-white/15 hover:bg-white/25" : "bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10"}`}
                          >
                            <span className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${mine ? "bg-white/20" : "bg-blue-600/15 text-blue-600 dark:text-blue-400"}`}>
                              <FileIcon className="h-4.5 w-4.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{m.file.name}</span>
                              <span className="block text-[11px] opacity-75">{fmtBytes(m.file.size)} · {m.file.name.split(".").pop()?.toUpperCase()}</span>
                            </span>
                            <Download className="h-4 w-4 shrink-0 opacity-75" />
                          </a>
                        )}
                        {m.poll ? (
                          <PollCard poll={m.poll} meID={me.id} mine={mine} canClose={mine || me.role === "admin"} />
                        ) : m.is_encrypted ? (
                          <EncryptedContent m={m} knownUsernames={knownUsernames} myUsername={me.username} />
                        ) : (
                          m.content && <FormattedContent content={m.content} knownUsernames={knownUsernames} myUsername={me.username} />
                        )}
                        <div className={`flex items-center justify-end gap-1.5 text-[10px] mt-0.5 ${mine ? "text-blue-100" : "text-zinc-500 dark:text-zinc-400"}`}>
                          {m.failed ? (
                            <div className="flex items-center gap-1 text-white font-medium">
                              <AlertCircle className="h-3 w-3" />
                              <span>Failed</span>
                              <button
                                onClick={() => retryMessage(m)}
                                className="inline-flex items-center gap-0.5 bg-white/20 hover:bg-white/30 px-1.5 py-0.5 rounded text-[10px] ml-1"
                              >
                                <RotateCcw className="h-2.5 w-2.5" /> Retry
                              </button>
                            </div>
                          ) : (
                            <>
                              {m.edited_at && <span className="italic opacity-80">edited</span>}
                              {fmtTime(m.sent_at)}
                              {mine && m.id > 0 && (group ? <GroupSeen msg={m} group={group} meID={me.id} reads={groupReads[group.id]} /> : <Ticks msg={m} />)}
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {!m.deleted_at && !!m.reactions?.length && (
                    <ReactionPills reactions={m.reactions} meID={me.id} mine={mine} onToggle={(emoji) => reactToMessage(m, emoji)} />
                  )}
                  {!m.deleted_at && (m.thread_count ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => setThreadRoot(m)}
                      className={`mt-1 flex items-center gap-1 text-xs font-semibold text-blue-500 hover:underline ${mine ? "ml-auto" : ""}`}
                    >
                      <MessageSquare className="h-3.5 w-3.5" /> {m.thread_count} {m.thread_count === 1 ? "reply" : "replies"}
                    </button>
                  )}
                </div>
                {!mine && canActOn(m) && (
                  <MessageActions
                    m={m}
                    onReply={() => { setReplyTo(m); setEditingID(null); }}
                    onDelete={groupModerator ? () => setDeleteMsgConfirm(m) : undefined}
                    onReact={() => setReactionPickerFor(reactionPickerFor === m.id ? null : m.id)}
                    onPin={canPin(m, me.id, me.role === "admin", group) ? () => pinMessage(m, !m.pinned_at) : undefined}
                    onForward={m.content && !m.is_encrypted ? () => setForwardingMsg(m) : undefined}
                    onSave={() => void toggleSave(m)}
                    saved={savedIDs.has(m.id)}
                    onThread={() => setThreadRoot(m)}
                    showReactionPicker={reactionPickerFor === m.id}
                    onPickReaction={(emoji) => { if (emoji) reactToMessage(m, emoji); setReactionPickerFor(null); }}
                    align="left"
                  />
                )}
              </SwipeToReply>
            </div>
          );
        })}
        {typingText && (
          <div className="flex items-center gap-2 pt-1 text-xs text-zinc-400">
            <div className="bg-zinc-800 border border-zinc-700 rounded-full px-3 py-1 flex items-center gap-1.5">
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-500 inline-block" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-500 inline-block" />
              <span className="typing-dot h-1.5 w-1.5 rounded-full bg-indigo-500 inline-block" />
              <span className="text-[11px] ml-1 text-zinc-500 text-zinc-400">{typingText}</span>
            </div>
          </div>
        )}
      </div>

      {/* composer */}
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-zinc-800 border-l-2 border-indigo-500 px-2.5 py-1.5">
            <ReplyIcon className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-blue-400">
                Replying to {replyTo.sender_id === me.id ? "yourself" : replyTo.sender?.display_name ?? "message"}
              </p>
              <p className="text-xs text-zinc-500 text-zinc-400 truncate flex items-center gap-1">
                {!replyTo.content && replyTo.file && <Paperclip className="h-3 w-3 shrink-0" />}
                <span className="truncate">{replyTo.content || replyTo.file?.name || ""}</span>
              </p>
            </div>
            <button
              onClick={() => setReplyTo(null)}
              className="h-6 w-6 shrink-0 rounded-full hover:bg-zinc-200 hover:bg-zinc-700 flex items-center justify-center text-zinc-400"
              aria-label="Cancel reply"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {sendError && (
          <button
            type="button"
            onClick={clearSendError}
            className="mb-2 w-full text-left text-xs text-rose-600 dark:text-rose-400 flex items-center justify-between"
            role="alert"
          >
            <span>{sendError}</span>
            <span className="font-semibold underline">Dismiss</span>
          </button>
        )}
        {uploadError && <p className="mb-2 text-xs text-rose-600 dark:text-rose-400" role="alert">{uploadError}</p>}
        <AttachmentPreview
          files={staged}
          onAddMore={() => fileInput.current?.click()}
          onRemove={(i) => setStaged((s) => s.filter((_, j) => j !== i))}
          onCancel={() => setStaged([])}
          onSend={(caption) => void sendStaged(caption)}
          progress={sendProgress}
          sending={uploading}
          encrypted={encrypted}
        />
        {peerBlocked ? (
          <div className="flex items-center justify-between gap-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 px-4 py-3 text-sm">
            <span>You blocked {peer?.display_name}. They can't message you.</span>
            <button onClick={() => void toggleBlock()} disabled={blockBusy} className="font-semibold text-blue-500 hover:underline">Unblock</button>
          </div>
        ) : (
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) stageFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => setShowPoll(true)}
            className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 shrink-0 transition cursor-pointer border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700/60"
            title="Create a poll"
            aria-label="Create a poll"
          >
            <BarChart3 className="h-5 w-5" />
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
            className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 shrink-0 transition cursor-pointer border border-transparent hover:border-zinc-200 dark:hover:border-zinc-700/60"
            title="Attach files (or drag & drop)"
            aria-label="Attach files"
          >
            {uploading ? <Loader2 className="h-5 w-5 animate-spin text-blue-500" /> : <Paperclip className="h-5 w-5" />}
          </button>
          <div className="relative flex-1 flex">
          {mention && mentionCandidates.length > 0 && (
            <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full mb-1 left-0 z-30 w-64 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface shadow-2xl py-1">
              {mentionCandidates.map((u, i) => (
                <li key={u.id} role="option" aria-selected={i === mentionIdx}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pickMention(u.username); }}
                    className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${i === mentionIdx ? "bg-surface-hover" : ""}`}
                  >
                    <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                    <span className="truncate font-medium">{u.display_name}</span>
                    <span className="text-xs text-ink-muted truncate">@{u.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            rows={1}
            placeholder={encrypted ? "Encrypted message… (Enter to send)" : "Type a message… (Enter to send)"}
            aria-label="Message"
            title="Enter to send, Shift+Enter for new line"
            className="flex-1 resize-none rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900/90 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 max-h-32 transition shadow-2xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          />
          </div>
          {recording ? (
            <>
              <span className="h-10 px-3 rounded-xl flex items-center gap-2 text-xs font-semibold text-rose-600" role="status" aria-live="polite">
                <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, "0")}
              </span>
              <button onClick={() => stopRecording(false)} className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500" aria-label="Cancel recording" title="Cancel">
                <X className="h-5 w-5" />
              </button>
              <button onClick={() => stopRecording(true)} className="h-10 w-10 rounded-xl bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center shrink-0" aria-label="Send voice message" title="Send voice message">
                <Square className="h-4 w-4" fill="currentColor" />
              </button>
            </>
          ) : !text.trim() && canRecord ? (
            <button onClick={() => void startRecording()} disabled={uploading} className="h-10 w-10 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 shrink-0 transition cursor-pointer" aria-label="Record voice message" title="Record voice message">
              <Mic className="h-5 w-5" />
            </button>
          ) : (
          <button
            onClick={send}
            disabled={!text.trim()}
            className="h-10 w-10 rounded-xl bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none shrink-0 shadow-md shadow-blue-600/25 active:scale-95 transition-all duration-150 cursor-pointer"
            aria-label="Send"
            title="Send (Enter)"
          >
            <Send className="h-4 w-4" />
          </button>
          )}
        </div>
        )}
      </div>

      {active && (
        <PollComposer
          open={showPoll}
          onClose={() => setShowPoll(false)}
          onCreate={(poll) => sendMessage(active, poll.question, undefined, undefined, { poll })}
        />
      )}
      {active && threadRoot && <ThreadModal convo={active} root={threadRoot} onClose={() => setThreadRoot(null)} />}
      <Modal open={blockConfirm} onClose={() => setBlockConfirm(false)} title="Block this person?">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            <span className="font-semibold text-zinc-900 dark:text-zinc-200">{peer?.display_name}</span> won't be able to send you direct messages, and you won't be able to send them any. Group chats and calls are unaffected. You can unblock them any time.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={() => setBlockConfirm(false)}>Cancel</button>
            <button type="button" className={btnDestructive} onClick={() => void toggleBlock()} disabled={blockBusy}>
              {blockBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Block
            </button>
          </div>
        </div>
      </Modal>

      {/* Forward Message Modal */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[80] bg-black/90 backdrop-blur flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.name}
          onKeyDown={(e) => { if (e.key === "Escape") setLightbox(null); }}
        >
          <img src={lightbox.src} alt={lightbox.name} className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <div className="absolute top-4 right-4 flex gap-2">
            <a href={lightbox.src} download={lightbox.name} onClick={(e) => e.stopPropagation()} className="h-10 w-10 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center" title="Download" aria-label="Download image">
              <Download className="h-4 w-4" />
            </a>
            <button onClick={() => setLightbox(null)} className="h-10 w-10 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center" aria-label="Close viewer">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
      <Modal open={!!forwardingMsg} onClose={() => { setForwardingMsg(null); setForwardSearch(""); }} title="Forward Message">
        <div className="space-y-3">
          {forwardingMsg && (
            <p className="text-xs bg-zinc-800 rounded-lg px-2.5 py-1.5 truncate text-zinc-500 text-zinc-400">
              {forwardingMsg.content}
            </p>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
            <input
              autoFocus
              value={forwardSearch}
              onChange={(e) => setForwardSearch(e.target.value)}
              placeholder="Search people and groups"
              className={`${inputCls} pl-8`}
            />
          </div>
          <div className="max-h-72 overflow-y-auto space-y-1">
            {groups
              .filter((g) => g.name.toLowerCase().includes(forwardSearch.toLowerCase()))
              .map((g) => (
                <button
                  key={`g${g.id}`}
                  onClick={() => forwardTo({ kind: "group", groupID: g.id })}
                  className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-800 transition text-left"
                >
                  <Avatar name={g.name} id={g.id} fileId={g.avatar_file_id} size="sm" />
                  <p className="text-sm font-medium truncate">{g.name}</p>
                </button>
              ))}
            {directoryUsers
              .filter((u) => u.id !== me.id && !u.disabled)
              .filter((u) => u.display_name.toLowerCase().includes(forwardSearch.toLowerCase()) || u.username.toLowerCase().includes(forwardSearch.toLowerCase()))
              .map((u) => (
                <button
                  key={`u${u.id}`}
                  onClick={() => forwardTo({ kind: "dm", peerID: u.id })}
                  className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-800 transition text-left"
                >
                  <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                  <p className="text-sm font-medium truncate">{u.display_name}</p>
                </button>
              ))}
          </div>
        </div>
      </Modal>

      {/* Group Info Modal */}
      {group && (
        <Modal
          open={showGroupInfo}
          onClose={() => {
            setShowGroupInfo(false);
            setEditingName(false);
            setEditingTopic(false);
            setShowAddMembers(false);
            setGroupActionError(null);
          }}
          title="Group Details"
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3 pb-3 border-b border-zinc-800">
              <div className="relative shrink-0">
                <Avatar name={group.name} id={group.id} fileId={group.avatar_file_id} size="lg" />
                {canManageGroup && (
                  <button
                    onClick={() => groupFileInput.current?.click()}
                    disabled={groupAvatarBusy}
                    className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-blue-600 hover:bg-indigo-500 text-white flex items-center justify-center shadow transition"
                    title="Change group icon"
                    aria-label="Change group icon"
                  >
                    {groupAvatarBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pencil className="h-3 w-3" />}
                  </button>
                )}
                <input
                  ref={groupFileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadGroupAvatar(f);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="min-w-0 flex-1">
                {editingName ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      className={`${inputCls} py-1 text-sm`}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void saveRename()}
                      maxLength={64}
                    />
                    <button
                      onClick={() => void saveRename()}
                      disabled={renamingBusy || !nameDraft.trim()}
                      className="h-7 w-7 shrink-0 rounded-lg bg-blue-600 hover:bg-indigo-500 text-white flex items-center justify-center disabled:opacity-50"
                      aria-label="Save group name"
                    >
                      {renamingBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      onClick={() => setEditingName(false)}
                      className="h-7 w-7 shrink-0 rounded-lg hover:bg-zinc-800 flex items-center justify-center"
                      aria-label="Cancel rename"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <p className="font-bold text-base truncate">{group.name}</p>
                    {canManageGroup && (
                      <button onClick={startRename} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="Rename group" title="Rename group">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <p className="text-xs text-zinc-400">{group.members.length} members{group.public ? " · public channel" : ""}</p>
                {canManageGroup && (
                  <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-blue-600"
                      checked={!!group.public}
                      onChange={(e) => void api.setGroupPublic(group.id, e.target.checked).then(() => useChats.getState().fetchGroups()).catch((err) => setGroupActionError(err?.message ?? "Could not change visibility"))}
                    />
                    Public channel (anyone can find and join)
                  </label>
                )}
                {group.avatar_file_id != null && canManageGroup && (
                  <button type="button" onClick={() => void removeGroupAvatar()} disabled={groupAvatarBusy} className="text-xs text-rose-500 hover:underline">
                    Remove icon
                  </button>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase text-zinc-400 tracking-wider mb-1">Topic</p>
              {editingTopic ? (
                <div className="flex items-start gap-1.5">
                  <textarea
                    autoFocus
                    rows={2}
                    maxLength={500}
                    className={`${inputCls} text-sm resize-none`}
                    value={topicDraft}
                    onChange={(e) => setTopicDraft(e.target.value)}
                  />
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={() => void saveTopic()}
                      disabled={topicBusy}
                      className="h-7 w-7 rounded-lg bg-blue-600 hover:bg-indigo-500 text-white flex items-center justify-center disabled:opacity-50"
                      aria-label="Save topic"
                    >
                      {topicBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </button>
                    <button onClick={() => setEditingTopic(false)} className="h-7 w-7 rounded-lg hover:bg-zinc-800 flex items-center justify-center" aria-label="Cancel topic edit">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-1.5">
                  <p className="text-sm text-zinc-500 text-zinc-400 flex-1 min-w-0 break-words">
                    {group.topic || <span className="italic text-zinc-400">No topic set</span>}
                  </p>
                  {canManageGroup && (
                    <button onClick={startTopicEdit} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 shrink-0" aria-label="Edit topic" title="Edit topic">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {groupActionError && <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">{groupActionError}</p>}

            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase text-zinc-400 tracking-wider">Members</p>
                {canManageGroup && (
                  <button
                    onClick={() => { setShowAddMembers((v) => !v); setGroupActionError(null); }}
                    className="text-xs font-medium text-blue-400 hover:underline inline-flex items-center gap-1"
                  >
                    <UserPlus className="h-3.5 w-3.5" /> Add
                  </button>
                )}
              </div>

              {showAddMembers && (
                <div className="mb-3 border border-zinc-800 rounded-xl p-2 space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
                    <input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="Search colleagues…"
                      className={`${inputCls} pl-8 py-1.5 text-xs`}
                    />
                  </div>
                  <div className="max-h-36 overflow-y-auto space-y-1">
                    {addableUsers.map((u) => (
                      <label key={u.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-zinc-800 cursor-pointer transition">
                        <input
                          type="checkbox"
                          checked={newMemberIDs.includes(u.id)}
                          onChange={(e) => setNewMemberIDs((ids) => (e.target.checked ? [...ids, u.id] : ids.filter((x) => x !== u.id)))}
                          className="h-4 w-4 accent-blue-600 rounded"
                        />
                        <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                        <p className="text-sm truncate">{u.display_name}</p>
                      </label>
                    ))}
                    {addableUsers.length === 0 && <p className="text-xs text-zinc-400 text-center py-2">No one else to add</p>}
                  </div>
                  <button
                    onClick={() => void handleAddMembers()}
                    disabled={addingMembers || newMemberIDs.length === 0}
                    className={`${btnPrimary} w-full text-sm py-1.5`}
                  >
                    {addingMembers ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                    Add {newMemberIDs.length > 0 ? `(${newMemberIDs.length})` : ""}
                  </button>
                </div>
              )}

              <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
                {group.members.map((m) => (
                  <div key={m.id} className="flex items-center justify-between py-1 group/member">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={m.display_name} id={m.id} fileId={m.avatar_file_id} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{m.display_name} {m.id === me.id && "(You)"}</p>
                        <p className="text-xs text-zinc-400 truncate">@{m.username}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {m.id === group.created_by ? (
                        <span className="text-[10px] font-semibold bg-indigo-100 dark:bg-indigo-900/40 text-blue-400 dark:text-indigo-300 px-2 py-0.5 rounded-full">
                          Owner
                        </span>
                      ) : m.role === "admin" ? (
                        <span className="text-[10px] font-semibold bg-zinc-800 text-zinc-500 text-zinc-400 px-2 py-0.5 rounded-full">
                          Admin
                        </span>
                      ) : null}
                      {isGroupOwner && m.id !== group.created_by && (
                        <button
                          onClick={() => void toggleMemberRole(m)}
                          disabled={roleBusyID === m.id}
                          title={m.role === "admin" ? "Remove admin" : "Make admin"}
                          aria-label={m.role === "admin" ? `Remove ${m.display_name} as admin` : `Make ${m.display_name} an admin`}
                          className="text-[10px] font-medium text-zinc-400 hover:text-blue-400 dark:hover:text-indigo-400 px-1.5 py-0.5 rounded transition disabled:opacity-50"
                        >
                          {roleBusyID === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : m.role === "admin" ? "Demote" : "Promote"}
                        </button>
                      )}
                      {canManageGroup && m.id !== group.created_by && (
                        pendingRemoveID === m.id ? (
                          <span className="flex items-center gap-1 text-[11px]">
                            <span className="text-zinc-400">Remove?</span>
                            <button
                              onClick={() => void handleRemoveMember(m.id)}
                              disabled={removingMemberID === m.id}
                              className="font-semibold text-rose-600 hover:underline disabled:opacity-50"
                            >
                              {removingMemberID === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
                            </button>
                            <button onClick={() => setPendingRemoveID(null)} className="text-zinc-400 hover:underline">
                              No
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setPendingRemoveID(m.id)}
                            title="Remove from group"
                            aria-label={`Remove ${m.display_name} from group`}
                            className="h-6 w-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition"
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="pt-3 border-t border-zinc-800 space-y-2">
              <a
                href={api.exportUrl({ groupID: group.id })}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-800 px-4 py-2 text-sm font-medium transition"
              >
                <Download className="h-4 w-4" />
                Export Conversation
              </a>
              {group.created_by !== me.id && (
                confirmLeave ? (
                  <div className="flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm">
                    <span className="flex-1 text-zinc-500">Leave this group?</span>
                    <button onClick={() => setConfirmLeave(false)} className="font-medium text-zinc-500 hover:underline" disabled={leavingGroup}>
                      Cancel
                    </button>
                    <button onClick={() => void handleLeaveGroup()} className="font-semibold text-rose-600 hover:underline disabled:opacity-50" disabled={leavingGroup}>
                      {leavingGroup ? "Leaving…" : "Leave"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmLeave(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-800 px-4 py-2 text-sm font-medium transition"
                  >
                    <LogOut className="h-4 w-4" />
                    Leave Group
                  </button>
                )
              )}
              {isGroupOwner && (
                confirmDeleteGroup ? (
                  <div className="flex items-center gap-2 rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 px-3 py-2 text-sm">
                    <span className="flex-1 text-rose-700 dark:text-rose-300">Delete for everyone? This can't be undone.</span>
                    <button onClick={() => setConfirmDeleteGroup(false)} className="font-medium text-zinc-500 hover:underline" disabled={deletingGroup}>
                      Cancel
                    </button>
                    <button onClick={handleDeleteGroup} className="font-semibold text-rose-600 hover:underline disabled:opacity-50" disabled={deletingGroup}>
                      {deletingGroup ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteGroup(true)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 text-sm font-medium transition"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete Group
                  </button>
                )
              )}
            </div>
          </div>
        </Modal>
      )}

      <Modal open={!!deleteMsgConfirm} onClose={() => setDeleteMsgConfirm(null)} title="Delete message?">
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 text-zinc-300">This can't be undone.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={() => setDeleteMsgConfirm(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={btnDestructive}
              onClick={() => {
                if (deleteMsgConfirm) deleteMessage(deleteMsgConfirm);
                setDeleteMsgConfirm(null);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Swipe a message to the right to reply to it, like WhatsApp. Touch only;
 * with a mouse the Reply button in the message actions does the same.
 */
function SwipeToReply({
  enabled,
  onReply,
  className,
  children,
}: {
  enabled: boolean;
  onReply: () => void;
  className: string;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<"h" | "v" | null>(null);
  const THRESHOLD = 60;

  if (!enabled) return <div className={className}>{children}</div>;
  return (
    <div
      className={`relative ${className}`}
      style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? "none" : "transform 0.2s ease-out", touchAction: "pan-y" }}
      onTouchStart={(e) => {
        start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        axis.current = null;
      }}
      onTouchMove={(e) => {
        if (!start.current) return;
        const mx = e.touches[0].clientX - start.current.x;
        const my = e.touches[0].clientY - start.current.y;
        if (!axis.current && (Math.abs(mx) > 8 || Math.abs(my) > 8)) axis.current = Math.abs(mx) > Math.abs(my) ? "h" : "v";
        if (axis.current === "h") setDx(Math.max(0, Math.min(mx, 90)));
      }}
      onTouchEnd={() => {
        if (dx >= THRESHOLD) {
          onReply();
          navigator.vibrate?.(12);
        }
        start.current = null;
        setDx(0);
      }}
    >
      {dx > 0 && (
        <span
          className="absolute -left-9 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full bg-blue-600/15 text-blue-500 flex items-center justify-center"
          style={{ opacity: Math.min(dx / THRESHOLD, 1), transform: `translateY(-50%) scale(${0.6 + 0.4 * Math.min(dx / THRESHOLD, 1)})` }}
          aria-hidden="true"
        >
          <ReplyIcon className="h-4 w-4" />
        </span>
      )}
      {children}
    </div>
  );
}
