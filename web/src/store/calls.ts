import { create } from "zustand";
import { ws } from "../lib/ws";
import { api } from "../lib/api";
import { useAuth } from "./auth";
import { DirectCall } from "../lib/webrtc/direct";
import { RoomClient, type RemoteTracks } from "../lib/webrtc/sfu";
import type { NetQuality } from "../lib/webrtc/netmonitor";
import { startRingtone, stopRingtone, notify, stopStream } from "../lib/media";
import { uuid } from "../lib/util";
import type { Call, Group, ParticipantInfo, PrivateRoom, UserBrief } from "../lib/types";

export type CallStatus = "idle" | "outgoing" | "incoming" | "connecting" | "waiting-approval" | "active";

// call:ended reasons that need explaining to the caller — "hangup"/"declined"
// (declined has its own toast already) and "missed" (callee side, no toast
// needed) intentionally aren't here.
function callEndReasonToast(reason: string | undefined): string | undefined {
  switch (reason) {
    case "offline": return "They're offline right now";
    case "busy": return "They're on another call";
    case "no-answer": return "No answer";
    case "unavailable": return "That call is no longer available";
    case "server-error": return "Something went wrong starting the call";
    default: return undefined;
  }
}

interface Incoming {
  callId: string;
  from: UserBrief;
  video: boolean;
}

interface RoomInvite {
  roomId: string;
  groupName: string;
  from: UserBrief;
}

// A host-side "someone wants in" prompt for a private room requiring approval.
interface RoomJoinRequest {
  roomId: string;
  from: UserBrief;
}

interface CallsState {
  status: CallStatus;
  ringing: boolean; // true once the callee's device has been notified and is ringing (caller side)
  mode: "p2p" | "sfu";
  callId: string | null;
  roomId: string | null;
  peer: UserBrief | null;
  group: Group | null;
  privateRoom: { id: string; name: string } | null;
  roomJoinRequests: RoomJoinRequest[]; // host-side: people waiting to be let in
  startedWithVideo: boolean;
  startedAt: number | null;
  localStream: MediaStream | null;
  localScreenStream: MediaStream | null;
  remoteStream: MediaStream | null; // p2p only
  remoteMuted: boolean; // p2p remote mic state
  participants: ParticipantInfo[]; // sfu only
  remoteTracks: Record<number, RemoteTracks>; // sfu only
  raisedHands: Record<number, boolean>; // sfu only, user_id -> hand up
  presenterOnly: boolean; // sfu only: room-wide "only host/approved presenters can share screen"
  roster: { invitees: UserBrief[]; joined: number[] } | null; // host-only: private-room invite list vs who's actually joined
  showParticipants: boolean;
  networkQuality: NetQuality;
  wsReconnecting: boolean; // signaling socket dropped mid-call and is retrying
  mediaReconnecting: boolean; // the peer connection(s) themselves are down/recovering
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  minimized: boolean;
  inCallChat: boolean;
  activeGroupRooms: Record<number, boolean>;
  toast: string | null;
  incoming: Incoming | null;
  roomInvite: RoomInvite | null;
  history: Call[];
  historyLoaded: boolean;
  historyError: string | null;

  setMinimized: (minimized: boolean) => void;
  setInCallChat: (open: boolean) => void;
  setShowParticipants: (open: boolean) => void;
  startDmCall: (peer: UserBrief, video: boolean) => Promise<void>;
  acceptIncoming: (withVideo?: boolean) => Promise<void>;
  declineIncoming: () => void;
  hangup: () => void;
  toggleMic: () => void;
  toggleCam: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  switchDevice: (kind: "mic" | "cam", deviceId: string) => Promise<void>;
  startGroupCall: (group: Group, video?: boolean) => Promise<void>;
  acceptRoomInvite: () => Promise<void>;
  declineRoomInvite: () => void;
  joinPrivateRoom: (info: PrivateRoom, passcode?: string, video?: boolean) => Promise<void>;
  admitJoinRequest: (roomId: string, userID: number) => void;
  denyJoinRequest: (roomId: string, userID: number) => void;
  muteParticipant: (userID: number, lock?: boolean) => void;
  unlockParticipant: (userID: number) => void;
  kickParticipant: (userID: number) => void;
  setPresenterOnly: (enabled: boolean) => void;
  setPresenter: (userID: number, allowed: boolean) => void;
  fetchRoster: () => void;
  nudgeInvitee: (userID: number) => void;
  toggleRaiseHand: () => void;
  fetchHistory: () => Promise<void>;
  setToast: (t: string | null) => void;
  registerWs: () => void;
}

// Media engines live outside the store; the store mirrors their renderable state.
let direct: DirectCall | null = null;
let room: RoomClient | null = null;
let wsRegistered = false;
let callEpoch = 0;
let p2pReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let roomInviteTimer: ReturnType<typeof setTimeout> | null = null;

function clearP2PReconnectTimer() {
  if (p2pReconnectTimer) {
    clearTimeout(p2pReconnectTimer);
    p2pReconnectTimer = null;
  }
}

function newCallID() {
  return `p2p-${uuid()}`;
}

export const useCalls = create<CallsState>((set, get) => ({
  status: "idle",
  ringing: false,
  mode: "p2p",
  callId: null,
  roomId: null,
  peer: null,
  group: null,
  privateRoom: null,
  roomJoinRequests: [],
  startedWithVideo: false,
  startedAt: null,
  localStream: null,
  localScreenStream: null,
  remoteStream: null,
  remoteMuted: false,
  participants: [],
  remoteTracks: {},
  raisedHands: {},
  presenterOnly: false,
  roster: null,
  showParticipants: false,
  networkQuality: "good",
  wsReconnecting: false,
  mediaReconnecting: false,
  micOn: true,
  camOn: true,
  sharing: false,
  minimized: false,
  inCallChat: false,
  activeGroupRooms: {},
  toast: null,
  incoming: null,
  roomInvite: null,
  history: [],
  historyLoaded: false,
  historyError: null,

  setToast: (t) => set({ toast: t }),
  setMinimized: (minimized) => set({ minimized }),
  setInCallChat: (inCallChat) => set({ inCallChat }),
  setShowParticipants: (showParticipants) => set({ showParticipants }),

  startDmCall: async (peer, video) => {
    if (get().status !== "idle") {
      set({ toast: "Already in a call" });
      return;
    }
    if (!ws.connected) {
      set({ toast: "Realtime connection is unavailable" });
      return;
    }
    const epoch = ++callEpoch;
    const callId = newCallID();
    set({
      status: "outgoing",
      ringing: false,
      mode: "p2p",
      callId,
      peer,
      startedWithVideo: video,
      camOn: video,
      micOn: true,
      sharing: false,
      localScreenStream: null,
      startedAt: null,
      toast: null,
    });
    let call: DirectCall;
    call = new DirectCall({
      onRemoteStream: () => {
        if (callEpoch === epoch && direct === call) set({ remoteStream: new MediaStream(call.remoteStream.getTracks()) });
      },
      onState: (s) => {
        if (callEpoch !== epoch || direct !== call) return;
        if (s === "connected") {
          const localHasVideo = (call.localStream?.getVideoTracks().length ?? 0) > 0;
          const remoteHasVideo = (call.remoteStream?.getVideoTracks().length ?? 0) > 0;
          const convertedToVoice = get().startedWithVideo && !localHasVideo && !remoteHasVideo;
          set({
            status: "active",
            startedAt: Date.now(),
            toast: convertedToVoice ? "Camera permission not granted — converted to voice call" : get().toast,
          });
        }
        if (get().status === "active") set({ mediaReconnecting: s !== "connected" });
      },
      onSharingChange: (sharing, stream) => {
        if (callEpoch === epoch && direct === call) set({ sharing, localScreenStream: stream });
      },
      onNetworkQuality: (q) => {
        if (callEpoch === epoch && direct === call) set({ networkQuality: q });
      },
    });
    direct = call;
    try {
      await call.startAsCaller(peer, callId, video);
      if (callEpoch !== epoch || direct !== call || get().callId !== callId) {
        call.close();
        return;
      }
      const actualVideo = (call.localStream?.getVideoTracks().length ?? 0) > 0;
      set({
        localStream: call.localStream,
        camOn: actualVideo,
        toast: video && !actualVideo ? "Camera access not granted — calling with voice only" : null,
      });
    } catch {
      if (callEpoch !== epoch || direct !== call) {
        call.close();
        return;
      }
      set({
        toast: "Could not access microphone/camera",
        status: "idle",
        callId: null,
        peer: null,
        localStream: null,
        localScreenStream: null,
        remoteStream: null,
        startedAt: null,
        sharing: false,
      });
      call.close();
      if (direct === call) direct = null;
      return;
    }
    if (!ws.send("call:invite", { callee_id: peer.id, call_id: callId, video })) {
      callEpoch++;
      call.close();
      if (direct === call) direct = null;
      set({ status: "idle", callId: null, peer: null, localStream: null, localScreenStream: null, toast: "Call could not be started" });
    }
  },

  acceptIncoming: async (withVideo?: boolean) => {
    const inc = get().incoming;
    if (!inc) return;
    stopRingtone();
    if (get().status !== "idle") {
      ws.send("call:decline", { call_id: inc.callId });
      set({ incoming: null });
      return;
    }
    const enableVideo = withVideo !== undefined ? withVideo : inc.video;
    const epoch = ++callEpoch;
    set({
      incoming: null,
      status: "connecting",
      mode: "p2p",
      callId: inc.callId,
      peer: inc.from,
      startedWithVideo: inc.video,
      micOn: true,
      camOn: enableVideo,
      localScreenStream: null,
      toast: null,
    });
    let call: DirectCall;
    call = new DirectCall({
      onRemoteStream: () => {
        if (callEpoch === epoch && direct === call) set({ remoteStream: new MediaStream(call.remoteStream.getTracks()) });
      },
      onState: (s) => {
        if (callEpoch !== epoch || direct !== call) return;
        if (s === "connected") {
          const localHasVideo = (call.localStream?.getVideoTracks().length ?? 0) > 0;
          const remoteHasVideo = (call.remoteStream?.getVideoTracks().length ?? 0) > 0;
          const convertedToVoice = get().startedWithVideo && !localHasVideo && !remoteHasVideo;
          set({
            status: "active",
            startedAt: Date.now(),
            toast: convertedToVoice ? "Camera permission not granted — converted to voice call" : get().toast,
          });
        }
        if (get().status === "active") set({ mediaReconnecting: s !== "connected" });
      },
      onSharingChange: (sharing, stream) => {
        if (callEpoch === epoch && direct === call) set({ sharing, localScreenStream: stream });
      },
      onNetworkQuality: (q) => {
        if (callEpoch === epoch && direct === call) set({ networkQuality: q });
      },
    });
    direct = call;
    try {
      await call.startAsCallee(inc.from, inc.callId, enableVideo);
      if (callEpoch !== epoch || direct !== call || get().callId !== inc.callId) {
        call.close();
        return;
      }
      call.enableRenegotiation();
      const actualVideo = (call.localStream?.getVideoTracks().length ?? 0) > 0;
      set({
        localStream: call.localStream,
        camOn: actualVideo,
        toast: enableVideo && !actualVideo ? "Camera access not granted — joined with voice only" : null,
      });
    } catch {
      if (callEpoch !== epoch || direct !== call) {
        call.close();
        return;
      }
      set({ toast: "Could not access microphone/camera", status: "idle", callId: null, peer: null, localStream: null, localScreenStream: null, remoteStream: null, startedAt: null, sharing: false });
      call.close();
      if (direct === call) direct = null;
      return;
    }
    if (!ws.send("call:accept", { call_id: inc.callId })) {
      callEpoch++;
      call.close();
      if (direct === call) direct = null;
      set({ status: "idle", callId: null, peer: null, localStream: null, localScreenStream: null, remoteStream: null, startedAt: null, sharing: false, toast: "Call could not be accepted" });
    }
  },

  declineIncoming: () => {
    const inc = get().incoming;
    stopRingtone();
    if (inc) {
      callEpoch++;
      ws.send("call:decline", { call_id: inc.callId });
    }
    set({ incoming: null });
  },

  hangup: () => {
    callEpoch++;
    const s = get();
    if (s.mode === "sfu" && s.roomId) {
      room?.leave();
      room = null;
    } else if (s.callId) {
      ws.send("call:hangup", { call_id: s.callId });
      direct?.close();
      direct = null;
    }
    clearP2PReconnectTimer();
    stopRingtone();
    stopStream(s.localStream);
    set({
      status: "idle",
      callId: null,
      roomId: null,
      peer: null,
      group: null,
      privateRoom: null,
      roomJoinRequests: [],
      startedAt: null,
      localStream: null,
      localScreenStream: null,
      remoteStream: null,
      remoteMuted: false,
      minimized: false,
      inCallChat: false,
      participants: [],
      remoteTracks: {},
      sharing: false,
      incoming: null,
      roomInvite: null,
      raisedHands: {},
      presenterOnly: false,
      roster: null,
      showParticipants: false,
      networkQuality: "good",
      wsReconnecting: false,
      mediaReconnecting: false,
    });
    void get().fetchHistory();
  },

  toggleMic: () => {
    const on = !get().micOn;
    const s = get();
    if (s.mode === "sfu") {
      room?.setMic(on);
    } else {
      direct?.setMic(on);
      if (s.peer && s.callId) {
        ws.send("webrtc:relay", {
          to: s.peer.id,
          call_id: s.callId,
          data: { type: "mute-state", muted: !on },
        });
      }
    }
    set({ micOn: on });
  },

  toggleCam: async () => {
    const on = !get().camOn;
    const epoch = callEpoch;
    try {
      if (get().mode === "sfu") await room?.setCam(on);
      else await direct?.setCam(on);
      if (callEpoch === epoch) set({ camOn: on });
    } catch {
      if (callEpoch === epoch) set({ toast: "Could not access camera" });
    }
  },

  toggleScreen: async () => {
    const epoch = callEpoch;
    try {
      if (get().sharing) {
        await room?.stopScreenShare();
        await direct?.stopScreenShare();
        if (callEpoch === epoch) set({ sharing: false, localScreenStream: null });
      } else {
        if (get().mode === "sfu") {
          await room?.startScreenShare();
          if (callEpoch === epoch) set({ sharing: !!room?.sharing, localScreenStream: room?.screenStream ?? null });
        } else {
          await direct?.startScreenShare();
          if (callEpoch === epoch) set({ sharing: true });
        }
      }
    } catch {
      if (callEpoch === epoch) set({ toast: "Screen sharing was cancelled" });
    }
  },

  switchDevice: async (kind, deviceId) => {
    const epoch = callEpoch;
    try {
      if (get().mode === "sfu") await room?.switchDevice(kind, deviceId);
      else await direct?.switchDevice(kind, deviceId);
      if (callEpoch === epoch) {
        const cur = room?.localStream ?? direct?.localStream;
        set({
          localStream: cur ? new MediaStream(cur.getTracks()) : null,
          camOn: kind === "cam" ? ((cur?.getVideoTracks().length ?? 0) > 0) : get().camOn,
        });
      }
    } catch {
      if (callEpoch === epoch) set({ toast: "Could not switch device" });
    }
  },

  startGroupCall: async (group, video = true) => {
    if (get().status !== "idle") {
      set({ toast: "Already in a call" });
      return;
    }
    if (!ws.connected) {
      set({ toast: "Realtime connection is unavailable" });
      return;
    }
    const epoch = ++callEpoch;
    const roomId = `group:${group.id}`;
    set({
      status: "connecting",
      mode: "sfu",
      roomId,
      group,
      startedWithVideo: video,
      micOn: true,
      camOn: video,
      sharing: false,
      participants: [],
      remoteTracks: {},
      startedAt: null,
      localScreenStream: null,
      toast: null,
    });
    let callRoom: RoomClient;
    callRoom = new RoomClient({
      onTracks: () => {
        if (callEpoch === epoch && room === callRoom) set({ remoteTracks: { ...callRoom.remoteTracks } });
      },
      onSharingChange: (sharing, stream) => {
        if (callEpoch === epoch && room === callRoom) set({ sharing, localScreenStream: stream });
      },
      onNetworkQuality: (q) => {
        if (callEpoch === epoch && room === callRoom) set({ networkQuality: q });
      },
      onConnectionState: (s) => {
        if (callEpoch === epoch && room === callRoom) set({ mediaReconnecting: s !== "connected" });
      },
    });
    room = callRoom;
    try {
      await callRoom.join(roomId, video);
      if (callEpoch !== epoch || room !== callRoom || get().roomId !== roomId) {
        callRoom.leave(false);
        return;
      }
      const actualVideo = (callRoom.localStream?.getVideoTracks().length ?? 0) > 0;
      set({
        localStream: callRoom.localStream,
        camOn: actualVideo,
        toast: video && !actualVideo ? "Camera access not granted — joined with voice only" : null,
      });
    } catch {
      if (callEpoch !== epoch || room !== callRoom) {
        callRoom.leave(false);
        return;
      }
      set({ toast: "Could not access microphone/camera", status: "idle", roomId: null, group: null, localStream: null, localScreenStream: null, sharing: false });
      callRoom.leave(false);
      room = null;
    }
  },

  acceptRoomInvite: async () => {
    const inv = get().roomInvite;
    if (!inv) return;
    stopRingtone();
    if (get().status !== "idle") {
      set({ roomInvite: null, toast: "Already in a call" });
      return;
    }
    const epoch = ++callEpoch;
    set({
      roomInvite: null,
      status: "connecting",
      mode: "sfu",
      roomId: inv.roomId,
      micOn: true,
      camOn: true,
      sharing: false,
      participants: [],
      remoteTracks: {},
      startedAt: null,
      localScreenStream: null,
      toast: null,
    });
    let callRoom: RoomClient;
    callRoom = new RoomClient({
      onTracks: () => {
        if (callEpoch === epoch && room === callRoom) set({ remoteTracks: { ...callRoom.remoteTracks } });
      },
      onSharingChange: (sharing, stream) => {
        if (callEpoch === epoch && room === callRoom) set({ sharing, localScreenStream: stream });
      },
      onNetworkQuality: (q) => {
        if (callEpoch === epoch && room === callRoom) set({ networkQuality: q });
      },
      onConnectionState: (s) => {
        if (callEpoch === epoch && room === callRoom) set({ mediaReconnecting: s !== "connected" });
      },
    });
    room = callRoom;
    try {
      await callRoom.join(inv.roomId, true);
      if (callEpoch !== epoch || room !== callRoom || get().roomId !== inv.roomId) {
        callRoom.leave(false);
        return;
      }
      set({ localStream: callRoom.localStream });
    } catch {
      if (callEpoch !== epoch || room !== callRoom) {
        callRoom.leave(false);
        return;
      }
      set({ toast: "Could not access microphone/camera", status: "idle", roomId: null, localStream: null, localScreenStream: null, sharing: false });
      callRoom.leave(false);
      room = null;
    }
  },

  declineRoomInvite: () => {
    stopRingtone();
    set({ roomInvite: null });
  },

  joinPrivateRoom: async (info, passcode, video = true) => {
    if (get().status !== "idle") {
      set({ toast: "Already in a call" });
      return;
    }
    if (!ws.connected) {
      set({ toast: "Realtime connection is unavailable" });
      return;
    }
    const epoch = ++callEpoch;
    const roomId = `priv:${info.id}`;
    set({
      status: "connecting",
      mode: "sfu",
      roomId,
      group: null,
      privateRoom: { id: info.id, name: info.name },
      startedWithVideo: video,
      micOn: true,
      camOn: video,
      sharing: false,
      participants: [],
      remoteTracks: {},
      startedAt: null,
      localScreenStream: null,
      toast: null,
    });
    let callRoom: RoomClient;
    callRoom = new RoomClient({
      onTracks: () => {
        if (callEpoch === epoch && room === callRoom) set({ remoteTracks: { ...callRoom.remoteTracks } });
      },
      onSharingChange: (sharing, stream) => {
        if (callEpoch === epoch && room === callRoom) set({ sharing, localScreenStream: stream });
      },
      onNetworkQuality: (q) => {
        if (callEpoch === epoch && room === callRoom) set({ networkQuality: q });
      },
      onConnectionState: (s) => {
        if (callEpoch === epoch && room === callRoom) set({ mediaReconnecting: s !== "connected" });
      },
    });
    room = callRoom;
    try {
      await callRoom.join(roomId, video, false, false, passcode);
      if (callEpoch !== epoch || room !== callRoom || get().roomId !== roomId) {
        callRoom.leave(false);
        return;
      }
      // A host-requiring-approval room may have already flipped us to
      // "waiting-approval" via the room:join-pending handler below — don't
      // clobber that back to "connecting"-flavored state.
      const actualVideo = (callRoom.localStream?.getVideoTracks().length ?? 0) > 0;
      set({
        localStream: callRoom.localStream,
        camOn: actualVideo,
        toast: video && !actualVideo ? "Camera access not granted — joined with voice only" : get().toast,
      });
    } catch (err: any) {
      if (callEpoch !== epoch || room !== callRoom) {
        callRoom.leave(false);
        return;
      }
      set({
        toast: err instanceof Error && err.message ? err.message : "Could not access microphone/camera",
        status: "idle", roomId: null, privateRoom: null, localStream: null, localScreenStream: null, sharing: false,
      });
      callRoom.leave(false);
      room = null;
    }
  },

  admitJoinRequest: (roomId, userID) => {
    if (!ws.send("room:admit", { room_id: roomId, user_id: userID })) {
      set({ toast: "Could not admit — connection lost" });
      return;
    }
    set((s) => ({ roomJoinRequests: s.roomJoinRequests.filter((r) => !(r.roomId === roomId && r.from.id === userID)) }));
  },

  denyJoinRequest: (roomId, userID) => {
    if (!ws.send("room:deny", { room_id: roomId, user_id: userID })) {
      set({ toast: "Could not deny — connection lost" });
      return;
    }
    set((s) => ({ roomJoinRequests: s.roomJoinRequests.filter((r) => !(r.roomId === roomId && r.from.id === userID)) }));
  },

  muteParticipant: (userID, lock = false) => {
    if (!ws.send("room:mute-request", { target_user_id: userID, lock })) {
      set({ toast: "Could not mute — connection lost" });
    }
  },

  unlockParticipant: (userID) => {
    if (!ws.send("room:unlock-request", { target_user_id: userID })) {
      set({ toast: "Could not unlock — connection lost" });
    }
  },

  kickParticipant: (userID) => {
    if (!ws.send("room:kick-request", { target_user_id: userID })) {
      set({ toast: "Could not remove participant — connection lost" });
    }
  },

  setPresenterOnly: (enabled) => {
    const roomId = get().roomId;
    if (!roomId) return;
    if (!ws.send("room:presenter-only-request", { room_id: roomId, enabled })) {
      set({ toast: "Could not update presenter mode — connection lost" });
    }
  },

  setPresenter: (userID, allowed) => {
    if (!ws.send("room:presenter-request", { target_user_id: userID, allowed })) {
      set({ toast: "Could not update presenter — connection lost" });
    }
  },

  fetchRoster: () => {
    const roomId = get().roomId;
    if (!roomId) return;
    ws.send("room:roster-request", { room_id: roomId });
  },

  nudgeInvitee: (userID) => {
    const roomId = get().roomId;
    if (!roomId) return;
    if (!ws.send("room:nudge-request", { room_id: roomId, target_user_id: userID })) {
      set({ toast: "Could not nudge — connection lost" });
    }
  },

  toggleRaiseHand: () => {
    const s = get();
    if (!s.roomId) return;
    const me = useAuth.getState().me;
    if (!me) return;
    const raised = !s.raisedHands[me.id];
    set({ raisedHands: { ...s.raisedHands, [me.id]: raised } });
    ws.send("call:raise-hand", { room_id: s.roomId, raised });
  },

  fetchHistory: async () => {
    try {
      const history = await api.calls();
      set({ history, historyLoaded: true, historyError: null });
    } catch (err: any) {
      // Keep any previously-loaded history on screen, but mark the failure so
      // the UI can tell "still loading" apart from "couldn't load" instead of
      // showing a spinner forever on a failed first load.
      set({ historyError: err?.message ?? "Couldn't load call history" });
    }
  },

  registerWs: () => {
    if (wsRegistered) return;
    wsRegistered = true;

    ws.on("call:outgoing", (d) => {
      if (get().status !== "outgoing" || get().callId !== d.call_id) return;
      set({ callId: d.call_id });
    });

    ws.on("call:invite", (d) => {
      if (get().status !== "idle" || get().incoming || get().roomInvite) {
        ws.send("call:decline", { call_id: d.call_id });
        return;
      }
      set({ incoming: { callId: d.call_id, from: d.from, video: d.video } });
      startRingtone();
      notify("Incoming call", `${d.from.display_name} is calling you`, { tag: "call", inApp: false, sound: false });
      // Tell the caller this device is actually ringing now, not just that
      // the invite was delivered — see call:ringing below for the caller
      // side. Without this, the caller only ever finds out via a final
      // call:ended (declined/no-answer/offline), with nothing in between.
      ws.send("call:ringing", { call_id: d.call_id });
    });

    ws.on("call:ringing", (d) => {
      if (d?.call_id && d.call_id !== get().callId) return;
      if (get().status === "outgoing") {
        set({ ringing: true });
        startRingtone();
      }
    });

    ws.on("call:accepted", async (d) => {
      if (d.call_id && d.call_id !== get().callId) return;
      stopRingtone();
      set({ status: "connecting", ringing: false, toast: null });
      direct?.enableRenegotiation();
      await direct?.makeOffer();
    });

    ws.on("call:declined", (d) => {
      if (d.call_id && d.call_id !== get().callId) return;
      clearP2PReconnectTimer();
      callEpoch++;
      stopStream(get().localStream);
      direct?.close();
      direct = null;
      stopRingtone();
      set({ status: "idle", callId: null, peer: null, localStream: null, localScreenStream: null, remoteStream: null, startedAt: null, sharing: false, toast: "Call declined" });
      void get().fetchHistory();
    });

    ws.on("call:ended", (d) => {
      const current = get();
      const incomingID = current.incoming?.callId;
      if (d.call_id && current.callId !== d.call_id && incomingID !== d.call_id) return;
      clearP2PReconnectTimer();
      callEpoch++;
      const wasIdle = get().status === "idle";
      stopStream(get().localStream);
      direct?.close();
      direct = null;
      room?.leave(); // stop PeerConnections and media tracks before nullifying
      room = null;
      stopRingtone();
      set({
        status: "idle",
        callId: null,
        roomId: null,
        peer: null,
        group: null,
        incoming: null,
        localStream: null,
        localScreenStream: null,
        remoteStream: null,
        participants: [],
        remoteTracks: {},
        startedAt: null,
        sharing: false,
        toast: d.reason === "missed" ? null : callEndReasonToast(d.reason) ?? get().toast,
      });
      if (!wasIdle || d.reason === "missed" || d.reason === "no-answer") {
        void get().fetchHistory();
      }
    });

    ws.on("webrtc:relay", (d) => {
      if (d.data?.type === "mute-state") {
        set({ remoteMuted: !!d.data.muted });
      } else {
        void direct?.onRelay(d.data);
      }
    });

    ws.on("room:invite", (d) => {
      const gid = d.group_id ?? (d.room_id?.startsWith("group:") ? Number(d.room_id.slice(6)) : 0);
      if (gid) {
        set((s) => ({ activeGroupRooms: { ...s.activeGroupRooms, [gid]: true } }));
      }
      if (get().status !== "idle" || get().roomInvite || get().incoming) return;
      set({ roomInvite: { roomId: d.room_id, groupName: d.group_name, from: d.from } });
      startRingtone();
      // Stop ringing like a missed 1:1 call would; the group keeps its
      // "join call" badge, so the call can still be joined from the chat.
      if (roomInviteTimer) clearTimeout(roomInviteTimer);
      roomInviteTimer = setTimeout(() => {
        roomInviteTimer = null;
        if (get().roomInvite?.roomId === d.room_id) get().declineRoomInvite();
      }, 45000);
      notify("Group call", `${d.from.display_name} started a call in ${d.group_name}`, { tag: "room", inApp: false, sound: false });
    });

    ws.on("room:joined", (d) => {
      const gid = d.room_id?.startsWith("group:") ? Number(d.room_id.slice(6)) : 0;
      if (gid) {
        set((s) => ({ activeGroupRooms: { ...s.activeGroupRooms, [gid]: true } }));
      }
      if (get().mode !== "sfu" || (get().status !== "connecting" && get().status !== "active")) return;
      if (d.room_id && d.room_id !== get().roomId) return;
      room?.handleRoomJoined(d.resumed === true);
      set({
        participants: d.participants ?? [],
        status: "active",
        startedAt: get().startedAt ?? Date.now(),
        toast: null,
        wsReconnecting: false,
      });
    });

    ws.on("room:participant", (d) => {
      if (get().mode !== "sfu" || (get().status !== "connecting" && get().status !== "active")) return;
      if (d.room_id && d.room_id !== get().roomId) return;
      const p = d.participant as ParticipantInfo;
      set({
        participants: (() => {
          const list = [...get().participants];
          const i = list.findIndex((x) => x.user_id === p.user_id);
          if (i >= 0) list[i] = p;
          else list.push(p);
          return list;
        })(),
      });
    });

    ws.on("room:left", (d) => {
      if (get().mode !== "sfu" || (get().status !== "connecting" && get().status !== "active")) return;
      if (d.room_id && d.room_id !== get().roomId) return;
      const tracks = { ...get().remoteTracks };
      delete tracks[d.user_id];
      set({
        participants: get().participants.filter((p) => p.user_id !== d.user_id),
        remoteTracks: tracks,
      });
    });

    ws.on("room:closed", (d) => {
      const gid = d.room_id?.startsWith("group:") ? Number(d.room_id.slice(6)) : 0;
      if (gid) {
        set((s) => {
          const copy = { ...s.activeGroupRooms };
          delete copy[gid];
          return { activeGroupRooms: copy };
        });
      }
      if (get().mode !== "sfu" || (d.room_id && d.room_id !== get().roomId)) return;
      callEpoch++;
      const current = get();
      room?.leave(false);
      room = null;
      stopStream(current.localStream);
      stopRingtone();
      set({
        status: "idle",
        callId: null,
        roomId: null,
        peer: null,
        group: null,
        privateRoom: null,
        roomJoinRequests: [],
        incoming: null,
        localStream: null,
        localScreenStream: null,
        participants: [],
        remoteTracks: {},
        startedAt: null,
        sharing: false,
        minimized: false,
        inCallChat: false,
        showParticipants: false,
        presenterOnly: false,
        roster: null,
        raisedHands: {},
        networkQuality: "good",
        wsReconnecting: false,
        mediaReconnecting: false,
        toast: "This group call ended",
      });
      void get().fetchHistory();
    });

    ws.on("room:join-pending", (d) => {
      if (d?.room_id && d.room_id !== get().roomId) return;
      if (get().status === "connecting") set({ status: "waiting-approval" });
    });

    ws.on("room:join-approved", (d) => {
      if (d?.room_id && d.room_id !== get().roomId) return;
      if (get().status !== "waiting-approval") return;
      set({ status: "connecting" });
      room?.resendJoin();
    });

    ws.on("room:join-denied", (d) => {
      if (d?.room_id && d.room_id !== get().roomId) return;
      callEpoch++;
      stopStream(get().localStream);
      room?.leave(false);
      room = null;
      set({
        status: "idle", roomId: null, privateRoom: null, localStream: null, localScreenStream: null,
        participants: [], remoteTracks: {}, sharing: false, startedAt: null,
        toast: "The host denied your request to join",
      });
    });

    // Host-side: someone is waiting to be let into a private room this
    // client owns (surfaced regardless of whether the host is in-call yet).
    ws.on("room:join-request", (d) => {
      if (!d?.room_id || !d?.from) return;
      set((s) => ({
        roomJoinRequests: [...s.roomJoinRequests.filter((r) => !(r.roomId === d.room_id && r.from.id === d.from.id)), { roomId: d.room_id, from: d.from }],
      }));
    });

    ws.on("call:raise-hand", (d) => {
      if (d.room_id && d.room_id !== get().roomId) return;
      set((s) => ({ raisedHands: { ...s.raisedHands, [d.user_id]: !!d.raised } }));
    });

    ws.on("room:muted", (d) => {
      if (get().mode === "sfu") room?.setMic(false);
      else direct?.setMic(false);
      set({ micOn: false, toast: d?.locked ? "You were muted and locked by the host" : "You were muted by the host" });
    });

    ws.on("room:unlocked", () => {
      set({ toast: "The host unlocked your microphone — you can unmute now" });
    });

    // The host removed you specifically (distinct from "room:closed", which
    // ends the call for everyone) — tear down the same way hangup() does.
    ws.on("room:removed", () => {
      callEpoch++;
      const current = get();
      room?.leave(false);
      room = null;
      stopStream(current.localStream);
      stopRingtone();
      set({
        status: "idle",
        callId: null,
        roomId: null,
        peer: null,
        group: null,
        privateRoom: null,
        roomJoinRequests: [],
        localStream: null,
        localScreenStream: null,
        participants: [],
        remoteTracks: {},
        startedAt: null,
        sharing: false,
        minimized: false,
        inCallChat: false,
        showParticipants: false,
        presenterOnly: false,
        roster: null,
        raisedHands: {},
        networkQuality: "good",
        wsReconnecting: false,
        mediaReconnecting: false,
        toast: "You were removed from the call by the host",
      });
      void get().fetchHistory();
    });

    ws.on("room:presenter-only", (d) => {
      if (d?.room_id && d.room_id !== get().roomId) return;
      set({ presenterOnly: !!d?.enabled, toast: d?.enabled ? "Only the host and approved presenters can share their screen now" : "Anyone can share their screen now" });
    });

    ws.on("room:roster", (d) => {
      if (d?.room_id && d.room_id !== get().roomId) return;
      set({ roster: { invitees: d.invitees ?? [], joined: d.joined ?? [] } });
    });

    ws.on("sfu:sub-offer", (d) => void room?.handleSubOffer(d));
    ws.on("sfu:sub-ice", (d) => void room?.handleSubICE(d));
    ws.on("sfu:pub-answer", (d) => void room?.handlePubAnswer(d));
    ws.on("sfu:pub-ice", (d) => void room?.handlePubICE(d));

    ws.on("ws:close", () => {
      const current = get();
      if (current.status === "active") {
        set({ wsReconnecting: true });
        if (current.mode === "sfu") {
          // Signaling dropped mid-call but the media PeerConnections can stay
          // up on their own — ws.ts auto-reconnects with backoff and
          // room:joined (resumed:true) clears this once signaling is back.
          return;
        }
        if (current.mode === "p2p") {
          // Direct P2P media can continue uninterrupted even if signaling is temporarily lost.
          // Give 15 seconds grace period for WS to reconnect before tearing down the call.
          if (!p2pReconnectTimer) {
            p2pReconnectTimer = setTimeout(() => {
              p2pReconnectTimer = null;
              if (get().status === "active" && get().mode === "p2p" && !ws.connected) {
                get().hangup();
                set({ toast: "Call ended: Connection to server lost" });
              }
            }, 15000);
          }
          return;
        }
      }
      clearP2PReconnectTimer();
      if (current.status === "idle" && !current.incoming && !current.roomInvite) return;
      callEpoch++;
      direct?.close();
      direct = null;
      room?.leave(false);
      room = null;
      stopRingtone();
      stopStream(current.localStream);
      set({
        status: "idle",
        callId: null,
        roomId: null,
        peer: null,
        group: null,
        incoming: null,
        roomInvite: null,
        localStream: null,
        localScreenStream: null,
        remoteStream: null,
        participants: [],
        remoteTracks: {},
        startedAt: null,
        sharing: false,
        // The Shell banner already gives a clearer, actionable message for
        // this specific case (see ws.replaced) - avoid a redundant/confusing
        // second toast on top of it.
        toast: ws.replaced ? null : "Realtime connection lost",
      });
    });

    ws.on("error", (d) => {
      const current = get();
      if (current.mode === "sfu" && (current.status === "connecting" || current.status === "active") && d?.code === "room-join") {
        callEpoch++;
        room?.leave(false);
        room = null;
        stopStream(current.localStream);
        set({ status: "idle", roomId: null, group: null, localStream: null, localScreenStream: null, participants: [], remoteTracks: {}, sharing: false, toast: d?.message ?? "Could not join the group call" });
        void get().fetchHistory();
      } else if (current.mode === "sfu" && (current.status === "connecting" || current.status === "active") && !d?.client_id && d?.code !== "rate-limit") {
        // client_id marks a chat-send error; those belong to the chat UI.
        set({ toast: d?.message ?? "Call signaling error" });
      } else if (current.mode === "p2p" && (current.status === "outgoing" || current.status === "connecting") && d?.code === "call") {
        // Only errors about the call itself end it — the socket also carries
        // chat and rate-limit errors, which used to hang up a ringing call.
        callEpoch++;
        direct?.close();
        direct = null;
        stopStream(current.localStream);
        set({ status: "idle", callId: null, peer: null, localStream: null, localScreenStream: null, remoteStream: null, startedAt: null, sharing: false, toast: d?.message ?? "Call could not be started" });
      }
    });

    ws.on("ws:open", () => {
      clearP2PReconnectTimer();
      const s = get();
      // The server keeps a 1:1 call alive for a short grace period after
      // the socket drops; claim it back or it ends the call.
      if (s.mode === "p2p" && s.callId && s.status !== "idle") {
        ws.send("call:resume", { call_id: s.callId });
      }
      if (s.status === "active") {
        set({ wsReconnecting: false });
        // brief disconnect: re-attach to an SFU room without rebuilding PCs
        if (s.mode === "sfu" && room) {
          room.resume();
        }
      }
    });

    // I joined this call on another device: stop ringing here.
    ws.on("room:answered", (d) => {
      if (get().roomInvite?.roomId === d?.room_id) get().declineRoomInvite();
    });

    // A group's call finished (last participant left): drop its "join" badge.
    ws.on("room:ended", (d) => {
      // The call ended while it was still ringing here: stop ringing.
      if (get().roomInvite && get().roomInvite?.roomId === d?.room_id) {
        stopRingtone();
        set({ roomInvite: null });
      }
      const gid = Number(d?.group_id) || 0;
      if (!gid) return;
      set((s) => {
        const copy = { ...s.activeGroupRooms };
        delete copy[gid];
        return { activeGroupRooms: copy };
      });
    });
  },
}));
