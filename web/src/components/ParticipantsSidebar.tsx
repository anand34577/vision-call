import { useEffect, useMemo, useState } from "react";
import { Search, X, Crown, Mic, MicOff, Video, VideoOff, Hand, Lock, Unlock, UserX, MonitorUp, Bell } from "lucide-react";
import { useAuth } from "../store/auth";
import { useCalls } from "../store/calls";
import { Avatar, Modal, Switch, Menu, MenuItem, Button } from "./ui";
import type { ParticipantInfo } from "../lib/types";

function ParticipantRow({ info, isMe, isHost, isSpeaking, handRaised, presenterOnly, onAction }: {
  info: ParticipantInfo;
  isMe: boolean;
  isHost: boolean;
  isSpeaking?: boolean;
  handRaised?: boolean;
  presenterOnly: boolean;
  onAction: (action: "mute" | "mute-lock" | "unlock" | "kick" | "grant-present" | "revoke-present") => void;
}) {
  return (
    <div className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition ${isSpeaking ? "bg-brand/10" : "hover:bg-white/5"}`}>
      <Avatar name={info.display_name} id={info.user_id} fileId={info.avatar_file_id} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white truncate flex items-center gap-1.5">
          {info.host && <Crown className="h-3.5 w-3.5 text-warning shrink-0" />}
          <span className="truncate">{info.display_name}{isMe ? " (you)" : ""}</span>
        </p>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted mt-0.5">
          {info.locked ? (
            <span className="flex items-center gap-1 text-error"><Lock className="h-3 w-3" /> Locked</span>
          ) : info.muted ? (
            <span className="flex items-center gap-1"><MicOff className="h-3 w-3" /> Muted</span>
          ) : (
            <span className="flex items-center gap-1"><Mic className="h-3 w-3" /> Live</span>
          )}
          {presenterOnly && info.can_present && !info.host && <span className="flex items-center gap-1"><MonitorUp className="h-3 w-3" /> Presenter</span>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 text-ink-muted">
        {handRaised && <span title="Hand raised" className="text-warning"><Hand className="h-3.5 w-3.5" /></span>}
        <span title={info.video_on ? "Camera on" : "Camera off"}>{info.video_on ? <Video className="h-3.5 w-3.5" /> : <VideoOff className="h-3.5 w-3.5 opacity-50" />}</span>
      </div>
      {isHost && !isMe && (
        <Menu
          className="shrink-0"
          trigger={({ toggle, ref }) => (
            <button
              ref={ref}
              onClick={toggle}
              className="h-9 w-9 sm:h-7 sm:w-7 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-lg hover:bg-white/10 flex items-center justify-center text-ink-secondary"
              title="Participant actions"
              aria-label={`Actions for ${info.display_name}`}
            >
              <span className="text-lg leading-none">&#8942;</span>
            </button>
          )}
        >
          {!info.muted && (
            <MenuItem onClick={() => onAction("mute")}>
              <MicOff className="h-3.5 w-3.5" /> Mute
            </MenuItem>
          )}
          {info.locked ? (
            <MenuItem onClick={() => onAction("unlock")}>
              <Unlock className="h-3.5 w-3.5" /> Unlock mic
            </MenuItem>
          ) : (
            <MenuItem onClick={() => onAction("mute-lock")}>
              <Lock className="h-3.5 w-3.5" /> Mute &amp; lock
            </MenuItem>
          )}
          {presenterOnly && (
            info.can_present ? (
              <MenuItem onClick={() => onAction("revoke-present")}>
                <MonitorUp className="h-3.5 w-3.5" /> Revoke presenting
              </MenuItem>
            ) : (
              <MenuItem onClick={() => onAction("grant-present")}>
                <MonitorUp className="h-3.5 w-3.5" /> Allow presenting
              </MenuItem>
            )
          )}
          <MenuItem destructive onClick={() => onAction("kick")}>
            <UserX className="h-3.5 w-3.5" /> Remove from call
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}

// ParticipantsSidebar: who's in the call (searchable), who's invited but
// hasn't joined yet (private rooms, host-only), and host controls for
// muting/locking, restricting who can present, and removing someone.
export default function ParticipantsSidebar({ activeSpeakers }: { activeSpeakers: Record<number, boolean> }) {
  const me = useAuth((s) => s.me)!;
  const {
    participants, roomId, presenterOnly, roster, raisedHands,
    setShowParticipants, muteParticipant, unlockParticipant, kickParticipant,
    setPresenterOnly, setPresenter, fetchRoster, nudgeInvitee,
  } = useCalls();
  const [search, setSearch] = useState("");
  const [kickTarget, setKickTarget] = useState<ParticipantInfo | null>(null);
  const myInfo = participants.find((p) => p.user_id === me.id);
  const isHost = !!myInfo?.host;
  const isPrivateRoom = !!roomId?.startsWith("priv:");

  useEffect(() => {
    if (isHost && isPrivateRoom) fetchRoster();
  }, [isHost, isPrivateRoom, roomId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? participants.filter((p) => p.display_name.toLowerCase().includes(q)) : participants;
  }, [participants, search]);

  const notJoined = useMemo(() => {
    if (!roster) return [];
    const joined = new Set([...roster.joined, ...participants.map((p) => p.user_id)]);
    return roster.invitees.filter((u) => !joined.has(u.id));
  }, [roster, participants]);

  const act = (userID: number, action: "mute" | "mute-lock" | "unlock" | "kick" | "grant-present" | "revoke-present") => {
    switch (action) {
      case "mute": muteParticipant(userID, false); break;
      case "mute-lock": muteParticipant(userID, true); break;
      case "unlock": unlockParticipant(userID); break;
      case "kick": {
        const target = participants.find((p) => p.user_id === userID);
        if (target) setKickTarget(target);
        break;
      }
      case "grant-present": setPresenter(userID, true); break;
      case "revoke-present": setPresenter(userID, false); break;
    }
  };

  return (
    <aside className="absolute inset-y-0 right-0 w-full sm:static sm:w-80 shrink-0 border-l border-line bg-elevated flex flex-col z-20 shadow-2xl text-white">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line font-semibold text-sm shrink-0">
        <span>Participants · {participants.length}</span>
        <button onClick={() => setShowParticipants(false)} className="h-10 w-10 sm:h-9 sm:w-9 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-lg text-ink-muted hover:text-white hover:bg-white/10 flex items-center justify-center" title="Close participants" aria-label="Close participants">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search participants…"
            className="w-full rounded-lg bg-elevated border border-line pl-8 pr-2.5 py-1.5 text-sm text-white placeholder:text-ink-muted outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
      </div>

      {isHost && (
        <div className="px-4 pb-3 flex items-center justify-between shrink-0">
          <div>
            <p className="text-xs font-semibold flex items-center gap-1.5"><MonitorUp className="h-3.5 w-3.5" /> Presenter-only mode</p>
            <p className="text-[11px] text-ink-muted">Only you (and anyone you allow) can share their screen.</p>
          </div>
          <Switch checked={presenterOnly} onChange={setPresenterOnly} label="Presenter-only mode" />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {filtered.map((p) => (
          <ParticipantRow
            key={p.user_id}
            info={p}
            isMe={p.user_id === me.id}
            isHost={isHost}
            isSpeaking={activeSpeakers[p.user_id]}
            handRaised={!!raisedHands[p.user_id]}
            presenterOnly={presenterOnly}
            onAction={(action) => act(p.user_id, action)}
          />
        ))}
        {filtered.length === 0 && <p className="text-xs text-ink-muted text-center py-6">No matching participants</p>}

        {isHost && isPrivateRoom && notJoined.length > 0 && (
          <div className="pt-3 mt-3 border-t border-line">
            <p className="px-2.5 pb-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wide">Invited · not joined</p>
            {notJoined.map((u) => (
              <div key={u.id} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-white/5">
                <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                <p className="text-sm text-ink-secondary truncate flex-1 min-w-0">{u.display_name}</p>
                <button
                  onClick={() => nudgeInvitee(u.id)}
                  className="h-7 px-2 rounded-lg bg-white/10 hover:bg-white/20 text-xs flex items-center gap-1 shrink-0"
                  title="Nudge to join"
                >
                  <Bell className="h-3 w-3" /> Nudge
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={!!kickTarget} onClose={() => setKickTarget(null)} title="Remove from call?">
        <div className="space-y-4">
          <p className="text-sm text-ink-secondary-secondary">
            {kickTarget?.display_name} will be disconnected from this call immediately. They can rejoin if the room is still open.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setKickTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (kickTarget) kickParticipant(kickTarget.user_id);
                setKickTarget(null);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      </Modal>
    </aside>
  );
}

