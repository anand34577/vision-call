import { useEffect, useMemo, useState } from "react";
import { Phone, Video, MessageSquare, Search, Users, AlertTriangle, X } from "lucide-react";
import { useAuth } from "../store/auth";
import { useDirectory } from "../store/directory";
import { useCalls } from "../store/calls";
import { useChats } from "../store/chats";
import { Avatar, PresenceDot, inputCls, btnSecondary, SkeletonList, EmptyState } from "../components/ui";
import { presenceLabel } from "../lib/util";

export default function Directory() {
  const me = useAuth((s) => s.me)!;
  const { users, loaded, error, fetchUsers } = useDirectory();
  const startDmCall = useCalls((s) => s.startDmCall);
  const openDmStore = useChats((s) => s.openDm);
  // opening a DM from here also needs to switch the shell to the Chats view
  const openDm = (id: number) => {
    openDmStore(id);
    window.location.hash = "chats";
  };

  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "online" | "away" | "dnd" | "offline">("all");

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const others = useMemo(() => {
    return users.filter((u) => u.id !== me.id && !u.disabled);
  }, [users, me.id]);

  const filtered = useMemo(() => {
    const rank = (s: string) => (s === "online" ? 0 : s === "away" ? 1 : s === "dnd" ? 2 : s === "offline" ? 3 : 4);
    return others
      .filter((u) => {
        const matchesSearch = search
          ? u.display_name.toLowerCase().includes(search.toLowerCase()) ||
            u.username.toLowerCase().includes(search.toLowerCase())
          : true;
        const matchesStatus = filterStatus === "all" ? true : u.status === filterStatus;
        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => rank(a.status) - rank(b.status) || a.display_name.localeCompare(b.display_name));
  }, [others, search, filterStatus]);

  const onlineCount = others.filter((u) => u.status === "online").length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold font-display tracking-tight text-ink">Directory</h1>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-brand/15 text-brand border border-brand/25">
                {others.length} members
              </span>
            </div>
            <p className="text-xs text-ink-muted mt-1">
              {onlineCount} colleagues online right now
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search colleagues…"
                className={`${inputCls} pl-9 pr-8`}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* filter tabs */}
        <div className="flex gap-1.5 border-b border-line pb-3 overflow-x-auto">
          {(["all", "online", "away", "dnd", "offline"] as const).map((status) => (
            <button
              key={status}
              onClick={() => setFilterStatus(status)}
              aria-pressed={filterStatus === status}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition duration-150 cursor-pointer shrink-0 ${
                filterStatus === status
                  ? "bg-brand text-white shadow-xs"
                  : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
              }`}
            >
              {status === "dnd" ? "Do not disturb" : status}
            </button>
          ))}
        </div>

        {!loaded && !error && <SkeletonList rows={6} />}

        {error && (
          <div className="p-12 text-center flex flex-col items-center gap-3 bg-rose-950/20 border border-rose-900/50 rounded-xl">
            <AlertTriangle className="h-10 w-10 text-rose-500" />
            <p className="text-sm font-semibold text-rose-300">Couldn't load the directory</p>
            <p className="text-xs text-ink-muted max-w-sm">{error}</p>
            <button onClick={() => void fetchUsers()} className={btnSecondary}>
              Try again
            </button>
          </div>
        )}

        {loaded && !error && filtered.length === 0 && (
          <EmptyState
            icon={<Users className="h-6 w-6" />}
            title="No contacts found"
            hint={search ? `No colleagues matching "${search}".` : "No one matches this filter yet."}
            action={search ? <button onClick={() => { setSearch(""); setFilterStatus("all"); }} className={btnSecondary}>Clear search</button> : undefined}
          />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((u, i) => (
            <article
              key={u.id}
              style={{ "--i": i } as React.CSSProperties}
              aria-label={`${u.display_name}, ${presenceLabel(u.status)}`}
              className="animate-rise hover-lift rounded-xl border border-line bg-surface text-ink p-4 flex items-center gap-3.5 hover:border-line-strong group"
            >
              <button
                onClick={() => openDm(u.id)}
                className="flex items-center gap-3.5 min-w-0 flex-1 text-left rounded-lg cursor-pointer"
                aria-label={`Message ${u.display_name}`}
              >
                <div className="relative shrink-0">
                  <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="lg" />
                  <span className="absolute -bottom-0.5 -right-0.5">
                    <PresenceDot status={u.status} />
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-ink truncate group-hover:text-brand transition">
                    {u.display_name}
                  </p>
                  <p className="text-xs text-ink-muted truncate mt-0.5">@{u.username}</p>
                  <p className="text-[11px] mt-1 text-ink-muted flex items-center gap-1">
                    <span className="truncate">{presenceLabel(u.status)}{u.status_text ? ` · ${u.status_text}` : ""}</span>
                  </p>
                </div>
              </button>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => void startDmCall({ id: u.id, display_name: u.display_name, username: u.username, avatar_file_id: u.avatar_file_id }, false)}
                  title={`Call ${u.display_name}`}
                  aria-label={`Voice call ${u.display_name}`}
                  className="h-9 w-9 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line flex items-center justify-center text-ink-secondary hover:text-brand transition cursor-pointer"
                >
                  <Phone className="h-4 w-4" />
                </button>
                <button
                  onClick={() => void startDmCall({ id: u.id, display_name: u.display_name, username: u.username, avatar_file_id: u.avatar_file_id }, true)}
                  title={`Video call ${u.display_name}`}
                  aria-label={`Video call ${u.display_name}`}
                  className="h-9 w-9 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line flex items-center justify-center text-ink-secondary hover:text-brand transition cursor-pointer"
                >
                  <Video className="h-4 w-4" />
                </button>
                <button
                  onClick={() => openDm(u.id)}
                  disabled={u.disabled}
                  title="Message"
                  aria-label={`Message ${u.display_name}`}
                  className="h-9 w-9 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line flex items-center justify-center text-ink-secondary hover:text-brand transition cursor-pointer"
                >
                  <MessageSquare className="h-4 w-4" />
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
