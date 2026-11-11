import { useEffect, useMemo, useState } from "react";
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Users, Phone, Video, MessageSquare, AlertTriangle, PhoneCall } from "lucide-react";
import { useAuth } from "../store/auth";
import { useCalls } from "../store/calls";
import { useChats } from "../store/chats";
import { Avatar, btnSecondary, SkeletonList, EmptyState } from "../components/ui";
import { fmtDuration } from "../lib/util";

export default function CallsHistory() {
  const me = useAuth((s) => s.me)!;
  const { history, historyLoaded, historyError, fetchHistory, status, startDmCall, startGroupCall } = useCalls();
  const openDmStore = useChats((s) => s.openDm);
  const groups = useChats((s) => s.groups);
  // opening a DM from here also needs to switch the shell to the Chats view
  const openDm = (id: number) => {
    openDmStore(id);
    window.location.hash = "chats";
  };
  const [filter, setFilter] = useState<"all" | "missed" | "group">("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory, status]);

  const timeAgo = (iso: string) => {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const filteredHistory = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter((c) => {
      if (filter === "group" && !c.is_conference) return false;
      if (filter === "missed") {
        const missed = !c.is_conference
          ? (c.participants ?? []).some((p) => p.user_id === me.id && p.missed)
          : false;
        if (!missed) return false;
      }
      if (q) {
        const names = (c.participants ?? []).map((p) => p.user?.display_name ?? "").join(" ").toLowerCase();
        const init = c.initiator?.display_name?.toLowerCase() ?? "";
        if (!names.includes(q) && !init.includes(q)) return false;
      }
      return true;
    });
  }, [history, filter, me.id, query]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold font-display tracking-tight text-ink">Call History</h1>
            <p className="text-xs text-ink-muted mt-0.5">Recent incoming, outgoing, and conference calls</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search calls…"
                aria-label="Search calls"
                className="rounded-lg border border-line bg-surface pl-3 pr-3 py-1.5 text-xs w-40 sm:w-48 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 text-ink placeholder:text-ink-muted"
              />
            </div>
            <div className="flex gap-1 bg-surface-hover p-1 rounded-lg border border-line">
              {(["all", "missed", "group"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  aria-pressed={filter === tab}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold capitalize transition-all duration-150 cursor-pointer ${
                    filter === tab
                      ? "bg-surface text-ink shadow-xs border border-line"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!historyLoaded && !historyError && <SkeletonList rows={5} />}
        {historyError && (
          <div className="p-12 text-center flex flex-col items-center gap-3 bg-error/10 border border-error/10 rounded-xl">
            <AlertTriangle className="h-10 w-10 text-error" />
            <p className="text-sm font-semibold text-error">Couldn't load call history</p>
            <p className="text-xs text-ink-muted max-w-sm">{historyError}</p>
            <button onClick={() => void fetchHistory()} className={btnSecondary}>
              Try again
            </button>
          </div>
        )}
        {historyLoaded && !historyError && filteredHistory.length === 0 && (
          <EmptyState
            icon={<PhoneCall className="h-6 w-6" />}
            title="No calls found"
            hint={filter === "missed" ? "You have no missed calls." : query ? `Nothing matching "${query}".` : "No calls logged yet. Start one from the directory."}
          />
        )}

        <div className="space-y-1.5">
          {filteredHistory.map((c) => {
            const missedForMe =
              !c.is_conference &&
              (c.participants ?? []).some((p) => p.user_id === me.id && p.missed);
            const outgoing = c.initiator_id === me.id;
            const peerParticipant = (c.participants ?? []).find((p) => p.user_id !== me.id);
            const peerUser = peerParticipant?.user ?? (c.initiator_id !== me.id ? c.initiator : undefined);
            const others = (c.participants ?? [])
              .filter((p) => p.user_id !== me.id)
              .map((p) => p.user?.display_name ?? "Unknown");
            const Icon = c.is_conference ? Users : missedForMe ? PhoneMissed : outgoing ? PhoneOutgoing : PhoneIncoming;
            const iconCls = missedForMe
              ? "bg-error/10 dark:bg-error/10 text-error"
              : outgoing
                ? "bg-brand/15 text-brand"
                : "bg-success/10 dark:bg-success/10 text-success";

            return (
              <div
                key={c.id}
                className="flex items-center gap-4 rounded-xl p-4 bg-surface text-ink border border-line hover:border-line-strong hover:shadow-md transition-all duration-150 group"
              >
                <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${iconCls}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-semibold truncate ${missedForMe ? "text-error" : "text-ink"}`}>
                    {others.length ? others.join(", ") : (c.initiator?.display_name ?? "Call")}
                    {c.is_conference && " (Group Call)"}
                  </p>
                  <p className="text-xs text-ink-muted flex items-center gap-2 mt-0.5">
                    <span title={new Date(c.started_at).toLocaleString()}>
                      {timeAgo(c.started_at)}
                    </span>
                    {c.ended_at && <span>· {fmtDuration(c.started_at, c.ended_at)}</span>}
                    {!c.ended_at && <span className="text-success font-medium">· In progress</span>}
                    {missedForMe && <span className="text-error font-medium">· Missed</span>}
                  </p>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {!c.is_conference && peerUser && (
                    <>
                      <button
                        onClick={() => void startDmCall({ id: peerUser.id, display_name: peerUser.display_name, username: peerUser.username, avatar_file_id: peerUser.avatar_file_id }, false)}
                        className="h-9 w-9 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line text-ink-secondary hover:text-brand flex items-center justify-center transition active:scale-95 cursor-pointer"
                        title={`Voice call ${peerUser.display_name}`}
                        aria-label={`Voice call ${peerUser.display_name}`}
                      >
                        <Phone className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => void startDmCall({ id: peerUser.id, display_name: peerUser.display_name, username: peerUser.username, avatar_file_id: peerUser.avatar_file_id }, true)}
                        className="h-9 w-9 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line text-ink-secondary hover:text-brand flex items-center justify-center transition active:scale-95 cursor-pointer"
                        title={`Video call ${peerUser.display_name}`}
                        aria-label={`Video call ${peerUser.display_name}`}
                      >
                        <Video className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => openDm(peerUser.id)}
                        className="h-9 w-9 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line text-ink-secondary hover:text-ink flex items-center justify-center transition active:scale-95 cursor-pointer"
                        title={`Message ${peerUser.display_name}`}
                        aria-label={`Message ${peerUser.display_name}`}
                      >
                        <MessageSquare className="h-4 w-4" />
                      </button>
                      <Avatar
                        name={peerUser.display_name}
                        id={peerUser.id}
                        fileId={peerUser.avatar_file_id}
                        size="sm"
                      />
                    </>
                  )}
                  {c.is_conference && (
                    (() => {
                      const groupID = c.room_id.startsWith("group:") ? Number(c.room_id.slice(6)) : 0;
                      const grp = groups.find((g) => g.id === groupID);
                      if (!grp) return null;
                      return (
                        <button
                          onClick={() => void startGroupCall(grp)}
                          className="h-8 px-3 rounded-lg bg-brand hover:bg-brand-hover text-white text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition cursor-pointer"
                        >
                          <Video className="h-3.5 w-3.5" /> Call Group
                        </button>
                      );
                    })()
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
