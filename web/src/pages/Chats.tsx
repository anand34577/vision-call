import { FormEvent, useEffect, useMemo, useState } from "react";
import { Archive, BellOff, Hash, MessageSquareText, Plus, Search, Star, Video, Loader2, MessageSquare, Paperclip, Lock, X } from "lucide-react";
import { useAuth } from "../store/auth";
import { useDirectory } from "../store/directory";
import { useChats } from "../store/chats";
import { useCalls } from "../store/calls";
import { api } from "../lib/api";
import { Avatar, EmptyState, Modal, PresenceDot, Switch, btnPrimary, btnSecondary, inputCls } from "../components/ui";
import { fmtDay, fmtTime } from "../lib/util";
import ChatPanel from "../components/ChatPanel";
import type { Group, Message } from "../lib/types";
import { searchEncryptedLocally } from "../lib/localSearch";

export default function Chats() {
  const me = useAuth((s) => s.me)!;
  const { users, fetchUsers } = useDirectory();
  const {
    groups,
    fetchGroups,
    active,
    openDm,
    openGroup,
    unread,
    messagesByDm,
    messagesByGroup,
    fetchSaved,
    convoPrefs,
    decryptedContent,
  } = useChats();
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = Object.values(convoPrefs).filter((p) => p.archived).length;
  const { activeGroupRooms, startGroupCall } = useCalls();

  const [search, setSearch] = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState<number[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [mobilePanel, setMobilePanel] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupPublic, setGroupPublic] = useState(false);
  const [showChannels, setShowChannels] = useState(false);
  const [channels, setChannels] = useState<Group[] | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [joiningID, setJoiningID] = useState<number | null>(null);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSender, setSearchSender] = useState<number>(0);
  const [searchSince, setSearchSince] = useState("");
  const [searchUntil, setSearchUntil] = useState("");
  const [searchHasFile, setSearchHasFile] = useState(false);
  const [searchResults, setSearchResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [showSaved, setShowSaved] = useState(false);
  const [savedList, setSavedList] = useState<Message[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);

  useEffect(() => {
    void fetchUsers();
    void fetchGroups();
    void fetchSaved();
  }, [fetchUsers, fetchGroups, fetchSaved]);

  const filteredUsers = useMemo(
    () =>
      users
        .filter((u) => u.id !== me.id && !u.disabled)
        .filter((u) => !!convoPrefs[`dm:${u.id}`]?.archived === showArchived)
        .filter((u) =>
          search
            ? u.display_name.toLowerCase().includes(search.toLowerCase()) ||
              u.username.toLowerCase().includes(search.toLowerCase())
            : true,
        )
        .sort((a, b) => {
          const ua = unread[`dm:${a.id}`] ?? 0;
          const ub = unread[`dm:${b.id}`] ?? 0;
          if ((ua > 0) !== (ub > 0)) return ua > 0 ? -1 : 1;
          return lastTime("dm", b.id) - lastTime("dm", a.id);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users, me.id, search, unread, messagesByDm, convoPrefs, showArchived],
  );

  const filteredGroups = useMemo(
    () =>
      groups
        .filter((g) => !!convoPrefs[`g:${g.id}`]?.archived === showArchived)
        .filter((g) => (search ? g.name.toLowerCase().includes(search.toLowerCase()) : true))
        .sort((a, b) => {
          const ua = unread[`g:${a.id}`] ?? 0;
          const ub = unread[`g:${b.id}`] ?? 0;
          if ((ua > 0) !== (ub > 0)) return ua > 0 ? -1 : 1;
          return lastTime("g", b.id) - lastTime("g", a.id);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, search, unread, messagesByGroup, convoPrefs, showArchived],
  );

  const modalFilteredUsers = useMemo(
    () =>
      users
        .filter((u) => u.id !== me.id && !u.disabled)
        .filter((u) =>
          memberSearch
            ? u.display_name.toLowerCase().includes(memberSearch.toLowerCase()) ||
              u.username.toLowerCase().includes(memberSearch.toLowerCase())
            : true,
        ),
    [users, me.id, memberSearch],
  );

  const createGroup = async (e: FormEvent) => {
    e.preventDefault();
    if (!groupName.trim() || creatingGroup) return;
    setGroupError(null);
    setCreatingGroup(true);
    try {
      await api.createGroup(groupName.trim(), members, groupPublic);
      setGroupName("");
      setGroupPublic(false);
      setMembers([]);
      setShowNewGroup(false);
      void fetchGroups();
    } catch (err: any) {
      setGroupError(err?.message ?? "Could not create group");
    }
    setCreatingGroup(false);
  };

  useEffect(() => {
    const q = searchQuery.trim();
    const hasFilter = q.length >= 2 || searchSender !== 0 || searchSince || searchUntil || searchHasFile;
    if (!hasFilter) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    const signal = { cancelled: false };
    const t = setTimeout(() => {
      api
        .searchMessages({
          q: q.length >= 2 ? q : undefined,
          senderId: searchSender || undefined,
          since: searchSince ? new Date(searchSince).toISOString() : undefined,
          // "until" is a date picker value (midnight that day); push it to the
          // end of that day so the chosen day itself is included.
          until: searchUntil ? new Date(searchUntil + "T23:59:59").toISOString() : undefined,
          hasFile: searchHasFile || undefined,
        })
        .then((r) => {
          setSearchResults(r);
          setSearchError(null);
          // The server can't see inside encrypted chats: also look through
          // recent ones on this device, and merge any hits in.
          if (q.length >= 2) {
            void searchEncryptedLocally(q, me.id, signal).then((local) => {
              if (signal.cancelled || local.length === 0) return;
              setSearchResults((cur) => [...cur, ...local.filter((l) => !cur.some((c) => c.id === l.id))].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at)));
            }).catch(() => {});
          }
        })
        .catch((err) => setSearchError(err?.message ?? "Search failed"))
        .finally(() => setSearching(false));
    }, 300);
    return () => { signal.cancelled = true; clearTimeout(t); };
  }, [searchQuery, searchSender, searchSince, searchUntil, searchHasFile, me.id]);

  const openChannels = () => {
    setShowChannels(true);
    setChannels(null);
    setChannelError(null);
    api.publicGroups().then(setChannels).catch((err) => setChannelError(err?.message ?? "Could not load channels"));
  };

  const joinChannel = async (g: Group) => {
    setJoiningID(g.id);
    setChannelError(null);
    try {
      await api.joinGroup(g.id);
      await fetchGroups();
      setShowChannels(false);
      openGroup(g.id);
      setMobilePanel(true);
    } catch (err: any) {
      setChannelError(err?.message ?? "Could not join channel");
    }
    setJoiningID(null);
  };

  const openSearchResult = (m: Message) => {
    if (m.group_id) {
      openGroup(m.group_id);
    } else {
      const peerID = m.sender_id === me.id ? m.recipient_id : m.sender_id;
      if (peerID) openDm(peerID);
    }
    setShowSearch(false);
    setSearchQuery("");
    setMobilePanel(true);
  };

  // Function declarations (hoisted), not const arrows: the useMemo sorts
  // above call these during render, before a const would be initialized —
  // that was a "Cannot access before initialization" crash on every login
  // with 2+ contacts.
  function lastOf(kind: string, id: number) {
    const msgs = kind === "dm" ? messagesByDm[id] : messagesByGroup[id];
    return msgs?.[msgs.length - 1];
  }

  function lastTime(kind: string, id: number) {
    const m = lastOf(kind, id);
    return m ? Date.parse(m.sent_at) || 0 : 0;
  }

  // One-line preview of a chat's latest message: deleted and encrypted ones
  // must not show their raw (empty / ciphertext) content.
  const previewOf = (m: Message) =>
    m.deleted_at ? "Message deleted" : m.is_encrypted ? (decryptedContent[m.id] ?? "Encrypted message") : m.content || m.file?.name || "file";

  const hasDraft = (key: string) => {
    try {
      return !!(localStorage.getItem(`vc.draft.${key}`) || "").trim();
    } catch {
      return false;
    }
  };

  const hasAnyConversations = filteredGroups.length > 0 || filteredUsers.length > 0;

  return (
    <div className="flex-1 flex min-h-0">
      {/* conversation list */}
      <div
        className={`${mobilePanel ? "hidden" : "flex"} md:flex flex-col w-full md:w-80 lg:w-96 border-r border-line bg-sidebar text-ink shrink-0`}
      >
        <div className="p-3 border-b border-line space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-ink-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter people and groups"
                aria-label="Filter people and groups"
                className={`${inputCls} pl-9 pr-8`}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-ink-muted hover:text-ink cursor-pointer"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowSearch(true)}
              title="Search all messages"
              aria-label="Search all messages"
              className="h-10 w-10 rounded-xl hover:bg-surface-hover text-ink-secondary hover:text-ink flex items-center justify-center shrink-0 transition cursor-pointer border border-transparent hover:border-line"
            >
              <MessageSquareText className="h-4 w-4" />
            </button>
            <button
              onClick={openChannels}
              title="Browse channels"
              aria-label="Browse channels"
              className="h-10 w-10 rounded-xl hover:bg-surface-hover text-ink-secondary hover:text-ink flex items-center justify-center shrink-0 transition cursor-pointer border border-transparent hover:border-line"
            >
              <Hash className="h-4 w-4" />
            </button>
            {(archivedCount > 0 || showArchived) && (
              <button
                onClick={() => setShowArchived((v) => !v)}
                title={showArchived ? "Back to chats" : `Archived chats (${archivedCount})`}
                aria-label={showArchived ? "Back to chats" : `Archived chats (${archivedCount})`}
                aria-pressed={showArchived}
                className={`h-10 w-10 rounded-xl hover:bg-surface-hover flex items-center justify-center shrink-0 transition cursor-pointer border ${showArchived ? "border-brand/40 text-brand" : "border-transparent text-ink-secondary hover:text-ink hover:border-line"}`}
              >
                <Archive className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => {
                setShowSaved(true);
                setSavedLoading(true);
                api.savedMessages().then(setSavedList).finally(() => setSavedLoading(false));
              }}
              title="Saved messages"
              aria-label="Saved messages"
              className="h-10 w-10 rounded-xl hover:bg-surface-hover text-ink-secondary hover:text-ink flex items-center justify-center shrink-0 transition cursor-pointer border border-transparent hover:border-line"
            >
              <Star className="h-4 w-4" />
            </button>
            <button
              onClick={() => { setGroupError(null); setMemberSearch(""); setShowNewGroup(true); }}
              title="New group"
              aria-label="New group"
              className="h-10 w-10 rounded-xl bg-brand hover:bg-brand-hover text-white flex items-center justify-center shrink-0 shadow-md active:scale-95 transition cursor-pointer"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          {groupError && !showNewGroup && (
            <p className="text-xs text-rose-600 dark:text-rose-400" role="alert">{groupError}</p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {!hasAnyConversations && (
            <EmptyState
              icon={<MessageSquare className="h-6 w-6" />}
              title="No conversations found"
              hint={search ? "Try a different search term." : "Start a chat from the directory or create a group."}
              action={search ? undefined : <button onClick={() => { window.location.hash = "directory"; }} className={btnPrimary}>Browse directory</button>}
            />
          )}

          {filteredGroups.map((g, i) => {
            const last = lastOf("g", g.id);
            const n = unread[`g:${g.id}`] ?? 0;
            const hasActiveCall = !!activeGroupRooms[g.id];
            const isSelected = active?.kind === "group" && active.groupID === g.id;
            return (
              <div
                key={g.id}
                style={{ "--i": i } as React.CSSProperties}
                className={`animate-rise w-full flex items-center gap-1 rounded-2xl transition duration-150 border ${
                  isSelected
                    ? "bg-brand/10 border-brand/30 shadow-xs"
                    : "border-transparent hover:bg-surface-hover"
                }`}
              >
                <button
                  onClick={() => {
                    openGroup(g.id);
                    setMobilePanel(true);
                  }}
                  aria-label={`Open ${g.name}${n > 0 ? `, ${n} unread` : ""}${hasActiveCall ? ", live call" : ""}`}
                  className="min-w-0 flex-1 flex items-center gap-3 px-3 py-2.5 text-left cursor-pointer"
                >
                  <div className="relative shrink-0">
                    <Avatar name={g.name} id={g.id} fileId={g.avatar_file_id} />
                    {hasActiveCall && (
                      <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 bg-emerald-500 border-2 border-surface rounded-full animate-pulse" aria-label="Live call" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className={`text-sm truncate ${isSelected ? "font-bold text-brand" : "font-semibold text-ink"}`}>
                        {g.name}
                      </p>
                      {g.public && <Hash className="h-3 w-3 text-ink-muted shrink-0" aria-label="Public channel" />}
                      {convoPrefs[`g:${g.id}`]?.muted && <BellOff className="h-3 w-3 text-ink-muted shrink-0" aria-label="Muted" />}
                      {hasActiveCall && (
                        <span className="bg-emerald-600 text-white text-[9px] font-bold px-1.5 py-px rounded-full uppercase tracking-wider shadow-xs">
                          Live
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted truncate flex items-center gap-1 mt-0.5">
                      {hasDraft(`g:${g.id}`) ? (
                        <span className="truncate"><span className="font-semibold text-amber-600 dark:text-amber-400">Draft: </span>{(() => { try { return localStorage.getItem(`vc.draft.g:${g.id}`); } catch { return ""; } })()}</span>
                      ) : last ? (
                        <>
                          <span className="font-medium text-ink-secondary">{last.sender?.display_name ?? ""}:</span>
                          {!last.content && last.file && <Paperclip className="h-3 w-3 shrink-0" />}
                          <span className="truncate">{previewOf(last)}</span>
                        </>
                      ) : (
                        `${g.members.length} members`
                      )}
                    </p>
                  </div>
                  {n > 0 && (
                    <span className="rounded-full bg-brand text-white text-[10px] font-bold px-2 py-0.5 min-w-5 text-center shadow-xs">
                      {n > 99 ? "99+" : n}
                    </span>
                  )}
                </button>
                {hasActiveCall && (
                  <button
                    onClick={() => void startGroupCall(g)}
                    className="h-9 px-3 mr-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1 shrink-0 shadow-sm active:scale-95 transition cursor-pointer"
                    title="Join ongoing call"
                    aria-label={`Join ongoing call in ${g.name}`}
                  >
                    <Video className="h-3.5 w-3.5" /> Join
                  </button>
                )}
              </div>
            );
          })}

          {filteredUsers.map((u, i) => {
            const last = lastOf("dm", u.id);
            const n = unread[`dm:${u.id}`] ?? 0;
            const isSelected = active?.kind === "dm" && active.peerID === u.id;
            return (
              <button
                key={u.id}
                style={{ "--i": filteredGroups.length + i } as React.CSSProperties}
                onClick={() => {
                  openDm(u.id);
                  setMobilePanel(true);
                }}
                aria-label={`Open chat with ${u.display_name}${n > 0 ? `, ${n} unread` : ""}`}
                className={`animate-rise w-full flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition duration-150 cursor-pointer border ${
                  isSelected
                    ? "bg-brand/10 border-brand/30 shadow-xs"
                    : "border-transparent hover:bg-surface-hover"
                }`}
              >
                <div className="relative shrink-0">
                  <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} />
                  <span className="absolute -bottom-0.5 -right-0.5">
                    <PresenceDot status={u.status} />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm truncate ${isSelected ? "font-bold text-brand" : "font-semibold text-ink"}`}>
                    {u.display_name}
                  </p>
                  <p className="text-xs text-ink-muted truncate flex items-center gap-1 mt-0.5">
                    {hasDraft(`dm:${u.id}`) ? (
                      <span className="truncate"><span className="font-semibold text-amber-600 dark:text-amber-400">Draft: </span>{(() => { try { return localStorage.getItem(`vc.draft.dm:${u.id}`); } catch { return ""; } })()}</span>
                    ) : (
                      <>
                        {last && !last.content && last.file && <Paperclip className="h-3 w-3 shrink-0" />}
                        <span className="truncate">{last ? previewOf(last) : `@${u.username}`}</span>
                      </>
                    )}
                  </p>
                </div>
                {n > 0 && (
                  <span className="rounded-full bg-brand text-white text-[10px] font-bold px-2 py-0.5 min-w-5 text-center shadow-xs">
                    {n > 99 ? "99+" : n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* chat panel */}
      <div className={`${mobilePanel ? "flex" : "hidden"} md:flex flex-1 min-w-0`}>
        {active ? (
          <ChatPanel onBack={() => setMobilePanel(false)} />
        ) : (
          <div className="flex-1 hidden md:flex flex-col items-center justify-center text-ink-muted p-8 text-center gap-3">
            <div className="h-16 w-16 rounded-2xl bg-surface-hover border border-line flex items-center justify-center text-ink-muted">
              <MessageSquare className="h-8 w-8" />
            </div>
            <p className="text-base font-semibold text-ink">Select a conversation</p>
            <p className="text-xs text-ink-muted max-w-sm">
              Choose a contact or group from the left panel to begin chatting, voice calling, or video conferencing.
            </p>
          </div>
        )}
      </div>

      {/* Browse channels */}
      <Modal open={showChannels} onClose={() => setShowChannels(false)} title="Browse channels">
        <div className="space-y-3">
          {channelError && <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">{channelError}</p>}
          {channels === null && !channelError && <p className="text-sm text-zinc-400 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
          {channels?.length === 0 && <p className="text-sm text-zinc-400">There are no other public channels to join right now. Create one with the + button and switch on "Public channel".</p>}
          <ul className="max-h-80 overflow-y-auto divide-y divide-zinc-200 dark:divide-zinc-800">
            {channels?.map((g) => (
              <li key={g.id} className="flex items-center gap-3 py-2.5">
                <Avatar name={g.name} id={g.id} fileId={g.avatar_file_id} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate flex items-center gap-1"><Hash className="h-3.5 w-3.5 shrink-0" />{g.name}</p>
                  <p className="text-xs text-zinc-500 truncate">{g.member_count ?? 0} members{g.topic ? ` · ${g.topic}` : ""}</p>
                </div>
                <button className={btnSecondary} disabled={joiningID === g.id} onClick={() => void joinChannel(g)}>
                  {joiningID === g.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Join
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Modal>

      {/* New Group Modal */}
      <Modal open={showNewGroup} onClose={() => setShowNewGroup(false)} title="New Group">
        <form onSubmit={createGroup} className="space-y-4">
          <div>
            <label htmlFor="new-group-name" className="block text-xs font-semibold text-zinc-500 mb-1">Group Name</label>
            <input
              id="new-group-name"
              className={inputCls}
              placeholder="e.g. Engineering Team"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-zinc-500">Select Members ({members.length})</label>
            </div>
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
              <input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search colleagues…"
                className={`${inputCls} pl-8 py-1.5 text-xs`}
              />
            </div>
            <div className="max-h-52 overflow-y-auto space-y-1 border border-zinc-200 dark:border-zinc-800 rounded-xl p-1.5">
              {modalFilteredUsers.map((u) => (
                <label
                  key={u.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition"
                >
                  <input
                    type="checkbox"
                    checked={members.includes(u.id)}
                    onChange={(e) =>
                      setMembers((m) => (e.target.checked ? [...m, u.id] : m.filter((x) => x !== u.id)))
                    }
                    className="h-4 w-4 accent-blue-600 rounded"
                  />
                  <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{u.display_name}</p>
                    <p className="text-xs text-zinc-400 truncate">@{u.username}</p>
                  </div>
                </label>
              ))}
              {modalFilteredUsers.length === 0 && (
                <p className="text-xs text-zinc-400 text-center py-4">No users found</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5"><Hash className="h-4 w-4" /> Public channel</p>
              <p className="text-xs text-zinc-400">Anyone on this server can find it and join. Turn off to keep it invite-only.</p>
            </div>
            <Switch checked={groupPublic} onChange={setGroupPublic} label="Public channel" />
          </div>

          {groupError && <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">{groupError}</p>}
          
          <button className={`${btnPrimary} w-full`} disabled={!groupName.trim() || creatingGroup}>
            {creatingGroup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {creatingGroup ? "Creating group…" : "Create Group"}
          </button>
        </form>
      </Modal>

      {/* Message Search Modal */}
      <Modal
        open={showSearch}
        onClose={() => {
          setShowSearch(false);
          setSearchSender(0);
          setSearchSince("");
          setSearchUntil("");
          setSearchHasFile(false);
        }}
        title="Search Messages"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search your conversations…"
              className={`${inputCls} pl-8`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select value={searchSender} onChange={(e) => setSearchSender(Number(e.target.value))} aria-label="Filter by sender" className={`${inputCls} w-auto py-1.5 text-xs`}>
              <option value={0}>Anyone</option>
              {users.filter((u) => !u.deleted).map((u) => (
                <option key={u.id} value={u.id}>{u.display_name}</option>
              ))}
            </select>
            <input type="date" value={searchSince} onChange={(e) => setSearchSince(e.target.value)} aria-label="From date" className={`${inputCls} w-auto py-1.5 text-xs`} title="From date" />
            <input type="date" value={searchUntil} onChange={(e) => setSearchUntil(e.target.value)} aria-label="To date" className={`${inputCls} w-auto py-1.5 text-xs`} title="To date" />
            <label className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
              <input type="checkbox" checked={searchHasFile} onChange={(e) => setSearchHasFile(e.target.checked)} className="h-3.5 w-3.5 accent-blue-600 rounded" />
              Has attachment
            </label>
          </div>
          {searchError && <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">{searchError}</p>}
          <div className="max-h-96 overflow-y-auto space-y-1">
            {searching && (
              <p className="text-xs text-zinc-400 text-center py-4 flex items-center justify-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
              </p>
            )}
            {!searching && (searchQuery.trim().length >= 2 || searchSender !== 0 || searchSince || searchUntil || searchHasFile) && searchResults.length === 0 && (
              <p className="text-xs text-zinc-400 text-center py-4">No messages found</p>
            )}
            {searchResults.map((m) => {
              const group = m.group_id ? groups.find((g) => g.id === m.group_id) : undefined;
              return (
                <button
                  key={m.id}
                  onClick={() => openSearchResult(m)}
                  className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
                >
                  <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <span className="font-semibold text-zinc-600 dark:text-zinc-300">{m.sender?.display_name ?? "Someone"}</span>
                    {group && <span>in {group.name}</span>}
                    <span className="ml-auto">{fmtDay(m.sent_at)} {fmtTime(m.sent_at)}</span>
                  </div>
                  <p className="text-sm truncate flex items-center gap-1">
                    {m.is_encrypted ? <Lock className="h-3 w-3 shrink-0" /> : !m.content && m.file ? <Paperclip className="h-3 w-3 shrink-0" /> : null}
                    <span className="truncate">{m.is_encrypted ? "Encrypted message" : m.content || m.file?.name || ""}</span>
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </Modal>

      {/* Saved Messages Modal */}
      <Modal open={showSaved} onClose={() => setShowSaved(false)} title="Saved Messages">
        <div className="max-h-96 overflow-y-auto space-y-1">
          {savedLoading && (
            <p className="text-xs text-zinc-400 text-center py-4 flex items-center justify-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </p>
          )}
          {!savedLoading && savedList.length === 0 && (
            <p className="text-xs text-zinc-400 text-center py-6">
              No saved messages yet — star a message to bookmark it here.
            </p>
          )}
          {savedList.map((m) => {
            const group = m.group_id ? groups.find((g) => g.id === m.group_id) : undefined;
            return (
              <button
                key={m.id}
                onClick={() => { setShowSaved(false); openSearchResult(m); }}
                className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
              >
                <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <span className="font-semibold text-zinc-600 dark:text-zinc-300">{m.sender?.display_name ?? "Someone"}</span>
                  {group && <span>in {group.name}</span>}
                  <span className="ml-auto">{fmtDay(m.sent_at)} {fmtTime(m.sent_at)}</span>
                </div>
                <p className="text-sm truncate flex items-center gap-1">
                  {m.is_encrypted ? <Lock className="h-3 w-3 shrink-0" /> : !m.content && m.file ? <Paperclip className="h-3 w-3 shrink-0" /> : null}
                  <span className="truncate">{m.is_encrypted ? "Encrypted message" : m.content || m.file?.name || ""}</span>
                </p>
              </button>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}

