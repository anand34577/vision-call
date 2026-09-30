import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Copy, Check, Trash2, Lock, ShieldCheck, Users, Video, Loader2, Search, DoorOpen, KeyRound } from "lucide-react";
import { useAuth } from "../store/auth";
import { useDirectory } from "../store/directory";
import { useCalls } from "../store/calls";
import { api, ApiError } from "../lib/api";
import { Alert, Avatar, EmptyState, Modal, Switch, btnDestructive, btnGhost, btnPrimary, btnSecondary, inputCls } from "../components/ui";
import type { PrivateRoom } from "../lib/types";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition"
      title="Copy"
      aria-label="Copy"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export default function Rooms() {
  const me = useAuth((s) => s.me)!;
  const { users, fetchUsers } = useDirectory();
  const joinPrivateRoom = useCalls((s) => s.joinPrivateRoom);
  const callStatus = useCalls((s) => s.status);

  const [rooms, setRooms] = useState<PrivateRoom[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);
  const [invited, setInvited] = useState<number[]>([]);
  const [scheduledAt, setScheduledAt] = useState(""); // <input type="datetime-local"> value, local time
  const [memberSearch, setMemberSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState("");
  const [joinLookup, setJoinLookup] = useState<PrivateRoom | null>(null);
  const [joinPasscode, setJoinPasscode] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadRooms = () => {
    api.myRooms()
      .then((r) => { if (mounted.current) { setRooms(r); setLoaded(true); } })
      .catch(() => { if (mounted.current) setLoaded(true); });
  };

  useEffect(() => {
    loadRooms();
    void fetchUsers();
  }, []);

  const modalFilteredUsers = useMemo(
    () =>
      users
        .filter((u) => u.id !== me.id && !u.disabled)
        .filter((u) =>
          memberSearch
            ? u.display_name.toLowerCase().includes(memberSearch.toLowerCase()) || u.username.toLowerCase().includes(memberSearch.toLowerCase())
            : true,
        ),
    [users, me.id, memberSearch],
  );

  const createRoom = async (e: FormEvent) => {
    e.preventDefault();
    if (creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      await api.createRoom({ name: name.trim(), passcode: passcode.trim() || undefined, require_approval: requireApproval, invited_user_ids: invited, scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : undefined });
      setShowCreate(false);
      setScheduledAt("");
      setName(""); setPasscode(""); setRequireApproval(false); setInvited([]); setMemberSearch("");
      loadRooms();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not create room");
    }
    setCreating(false);
  };

  const [deleteTarget, setDeleteTarget] = useState<PrivateRoom | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteRoom = async (id: string) => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deleteRoom(id);
      setRooms((r) => r.filter((room) => room.id !== id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete room");
    }
    setDeleteBusy(false);
  };

  const lookupJoinCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setJoinError(null);
    setJoinLookup(null);
    setJoinBusy(true);
    try {
      const room = await api.getRoom(code);
      setJoinLookup(room);
    } catch (err) {
      setJoinError(err instanceof ApiError && err.status === 404 ? "No room with that code" : "Could not look up room");
    }
    setJoinBusy(false);
  };

  const doJoin = async (room: PrivateRoom) => {
    if (callStatus !== "idle") { setJoinError("You're already in a call"); return; }
    setJoinError(null);
    await joinPrivateRoom(room, room.require_passcode ? joinPasscode : undefined, true);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold font-display tracking-tight text-ink">Private Rooms</h1>
            <p className="text-xs text-ink-muted mt-1">Standalone call rooms with passcodes, approvals, or open codes.</p>
          </div>
          <button onClick={() => setShowCreate(true)} className={btnPrimary}>
            <Plus className="h-4 w-4" /> New Room
          </button>
        </div>

        {/* Join by code */}
        <section className="rounded-xl border border-line bg-surface text-ink p-5 space-y-4">
          <div className="flex items-center gap-2 text-ink font-semibold text-sm">
            <div className="h-7 w-7 rounded-lg bg-brand/15 text-brand flex items-center justify-center">
              <DoorOpen className="h-4 w-4" />
            </div>
            <span>Join a room</span>
          </div>
          <div className="flex gap-2">
            <input
              className={inputCls}
              placeholder="Enter room code (e.g. ROOM-123)"
              value={joinCode}
              aria-label="Room code"
              onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setJoinLookup(null); }}
              onKeyDown={(e) => e.key === "Enter" && void lookupJoinCode()}
            />
            <button onClick={() => void lookupJoinCode()} disabled={!joinCode.trim() || joinBusy} className={`${btnPrimary} px-4`}>
              {joinBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </button>
          </div>
          {joinError && <Alert variant="error">{joinError}</Alert>}
          {joinLookup && (
            <div className="rounded-xl bg-surface-hover border border-line p-4 space-y-3 animate-modal-in">
              <div className="flex items-center gap-3">
                {joinLookup.owner && <Avatar name={joinLookup.owner.display_name} id={joinLookup.owner.id} fileId={joinLookup.owner.avatar_file_id} size="md" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate text-ink">{joinLookup.name}</p>
                  <p className="text-xs text-ink-muted truncate">Hosted by {joinLookup.owner?.display_name ?? "someone"}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-xs text-ink-muted font-medium">
                {joinLookup.require_passcode && <span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-amber-400" /> Passcode required</span>}
                {joinLookup.require_approval && <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-brand" /> Host approval required</span>}
              </div>
              {joinLookup.require_passcode && (
                <input
                  type="password"
                  className={inputCls}
                  placeholder="Enter passcode to join"
                  value={joinPasscode}
                  onChange={(e) => setJoinPasscode(e.target.value)}
                />
              )}
              <button onClick={() => void doJoin(joinLookup)} className={`${btnPrimary} w-full py-2.5`}>
                <Video className="h-4 w-4" /> Join Room
              </button>
            </div>
          )}
        </section>

        {/* My rooms */}
        <section className="space-y-2">
          <h2 className="font-semibold text-sm text-ink px-1">My Rooms</h2>
          {!loaded && <p className="text-xs text-ink-muted px-1 flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading rooms…</p>}
          {loaded && rooms.length === 0 && (
            <EmptyState
              icon={<KeyRound className="h-6 w-6" />}
              title="No private rooms yet"
              hint="Create one to get a shareable code with optional passcode or host approval."
              action={<button onClick={() => setShowCreate(true)} className={btnPrimary}><Plus className="h-4 w-4" /> New Room</button>}
            />
          )}
          {rooms.map((room) => (
            <div key={room.id} className="rounded-xl border border-line bg-surface text-ink p-4 flex items-center gap-3.5 hover:border-line-strong hover:shadow-md transition-all duration-150">
              <div className="h-10 w-10 rounded-lg bg-brand/15 text-brand flex items-center justify-center shrink-0">
                <KeyRound className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">{room.name}</p>
                <div className="flex items-center gap-2 text-xs text-ink-muted mt-0.5">
                  <span className="font-mono tracking-wider bg-surface-hover border border-line px-1.5 py-0.5 rounded text-[11px] text-ink">{room.id}</span>
                  <CopyButton text={room.id} />
                  {room.require_passcode && <span title="Passcode required" className="text-amber-500"><Lock className="h-3 w-3" /></span>}
                  {room.require_approval && <span title="Approval required" className="text-brand"><ShieldCheck className="h-3 w-3" /></span>}
                </div>
                {(room.scheduled_at || !room.is_owner) && (
                  <p className="text-xs text-brand mt-1 font-medium">
                    {room.scheduled_at ? `Scheduled · ${new Date(room.scheduled_at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                    {!room.is_owner ? `${room.scheduled_at ? " · " : ""}Invited by ${room.owner?.display_name ?? "someone"}` : ""}
                  </p>
                )}
              </div>
              <button onClick={() => void doJoin(room)} className="h-10 px-3.5 rounded-xl bg-brand hover:bg-brand-hover text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 active:scale-95 transition cursor-pointer shadow-md">
                <Video className="h-3.5 w-3.5" /> {room.is_owner ? "Start" : "Join"}
              </button>
              {room.is_owner && <button
                onClick={() => { setDeleteError(null); setDeleteTarget(room); }}
                className="h-10 w-10 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/40 text-zinc-500 hover:text-rose-600 dark:hover:text-rose-400 flex items-center justify-center shrink-0 transition cursor-pointer"
                title="Delete room"
                aria-label={`Delete ${room.name}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>}
            </div>
          ))}
        </section>
      </div>

      {/* Create Room Modal */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="New Private Room">
        <form onSubmit={createRoom} className="space-y-4">
          <div>
            <label htmlFor="room-name" className="block text-xs font-semibold text-zinc-500 mb-1">Room Name</label>
            <input id="room-name" className={inputCls} placeholder={`${me.display_name}'s room`} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div>
            <label htmlFor="room-when" className="block text-xs font-semibold text-zinc-500 mb-1">Schedule for later (optional)</label>
            <input id="room-when" type="datetime-local" className={inputCls} value={scheduledAt} min={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} onChange={(e) => setScheduledAt(e.target.value)} />
            <p className="text-xs text-zinc-400 mt-1">Invited people will see it in their Rooms list with the start time.</p>
          </div>

          <div>
            <label htmlFor="room-passcode" className="block text-xs font-semibold text-zinc-500 mb-1">Passcode (optional)</label>
            <input id="room-passcode" type="password" autoComplete="off" className={inputCls} placeholder="Leave blank for no passcode" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
          </div>

          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm font-medium flex items-center gap-1.5"><ShieldCheck className="h-4 w-4" /> Require my approval</p>
              <p className="text-xs text-zinc-400">You'll get a prompt to admit each person before they join.</p>
            </div>
            <Switch checked={requireApproval} onChange={setRequireApproval} label="Require host approval" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-zinc-500 flex items-center gap-1"><Users className="h-3.5 w-3.5" /> Restrict to specific people ({invited.length})</label>
            </div>
            <p className="text-xs text-zinc-400 mb-1.5">Leave empty and anyone with the room code/passcode can try to join.</p>
            <div className="relative mb-2">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-400" />
              <input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search colleagues…"
                className={`${inputCls} pl-8 py-1.5 text-xs`}
              />
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1 border border-zinc-200 dark:border-zinc-700 rounded-lg p-1.5">
              {modalFilteredUsers.map((u) => (
                <label key={u.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer transition">
                  <input
                    type="checkbox"
                    checked={invited.includes(u.id)}
                    onChange={(e) => setInvited((m) => (e.target.checked ? [...m, u.id] : m.filter((x) => x !== u.id)))}
                    className="h-4 w-4 accent-blue-600 rounded"
                  />
                  <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-200 truncate">{u.display_name}</p>
                    <p className="text-xs text-zinc-500 truncate">@{u.username}</p>
                  </div>
                </label>
              ))}
              {modalFilteredUsers.length === 0 && <p className="text-xs text-zinc-600 text-center py-4">No users found</p>}
            </div>
          </div>

          {createError && <Alert variant="error">{createError}</Alert>}

          <button className={`${btnPrimary} w-full`} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {creating ? "Creating room…" : "Create Room"}
          </button>
        </form>
      </Modal>

      {/* Delete Room Confirmation */}
      <Modal open={!!deleteTarget} onClose={() => (deleteBusy ? null : setDeleteTarget(null))} title="Delete room?">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            This permanently deletes <span className="font-semibold text-zinc-900 dark:text-zinc-200">{deleteTarget?.name}</span> for everyone. This can't be undone.
          </p>
          {deleteError && <Alert variant="error">{deleteError}</Alert>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnSecondary} onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              Cancel
            </button>
            <button
              type="button"
              className={btnDestructive}
              disabled={deleteBusy}
              onClick={() => deleteTarget && void deleteRoom(deleteTarget.id)}
            >
              {deleteBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
