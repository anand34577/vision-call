import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  MicOff,
  Video as VideoIcon,
  VideoOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  Loader2,
  Crown,
  MicOff as MutedBadge,
  Minimize2,
  Maximize2,
  MessageSquare,
  PictureInPicture2,
  X,
  Hand,
  Circle,
  Square,
  RefreshCcw,
  Users,
} from "lucide-react";
import { useAuth } from "../store/auth";
import { useCalls } from "../store/calls";
import { useChats } from "../store/chats";
import { getPreferredDevice, listDevices, onDevicesChanged, setPreferredDevice, type DeviceList, createAudioMeter, supportsScreenCapture } from "../lib/media";
import { Avatar } from "./ui";
import ChatPanel from "./ChatPanel";
import ParticipantsSidebar from "./ParticipantsSidebar";
import type { ParticipantInfo } from "../lib/types";

function Video({
  stream,
  muted,
  mirror,
  className,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
    }
    const applySink = () => {
      if (muted || !ref.current) return;
      const sinkID = getPreferredDevice("speaker");
      const media = ref.current as HTMLVideoElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (sinkID && media.setSinkId) void media.setSinkId(sinkID).catch(() => {});
    };
    applySink();
    window.addEventListener("vc:device-preference", applySink);
    return () => window.removeEventListener("vc:device-preference", applySink);
  }, [stream, muted]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      data-call-video={muted ? "local" : "remote"}
      className={`${className ?? ""} ${mirror ? "-scale-x-100" : ""}`}
    />
  );
}

function RemoteAudio({ track, onVolume }: { track: MediaStreamTrack; onVolume?: (vol: number) => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const stream = new MediaStream([track]);
    ref.current.srcObject = stream;
    const applySink = () => {
      const sinkID = getPreferredDevice("speaker");
      const media = ref.current as (HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      }) | null;
      if (sinkID && media?.setSinkId) void media.setSinkId(sinkID).catch(() => {});
    };
    applySink();
    window.addEventListener("vc:device-preference", applySink);

    const cleanupMeter = onVolume ? createAudioMeter(stream, onVolume) : undefined;

    return () => {
      window.removeEventListener("vc:device-preference", applySink);
      if (cleanupMeter) cleanupMeter();
    };
  }, [track, onVolume]);

  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

function TrackVideo({ track, muted, mirror, className }: { track: MediaStreamTrack; muted?: boolean; mirror?: boolean; className?: string }) {
  const stream = useMemo(() => new MediaStream([track]), [track]);
  return <Video stream={stream} muted={muted} mirror={mirror} className={className} />;
}

const PIP_MIN_WIDTH = 112; // w-28
const PIP_MAX_WIDTH = 320; // w-80
const PIP_DEFAULT_WIDTH = 160; // w-40

// DraggablePiP lets the self-view thumbnail be dragged anywhere over its
// (relatively-positioned) parent, snaps to the nearest corner on release
// (like the floating bubble in WhatsApp/Messenger calls), and resizes on a
// two-finger pinch. Plain pointer events — no drag/gesture library needed.
// `defaultClassName` supplies the starting corner (e.g. "bottom-4 right-4")
// via Tailwind; once dragged, inline left/top take over.
function DraggablePiP({ children, className, defaultClassName }: { children: React.ReactNode; className?: string; defaultClassName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [width, setWidth] = useState(PIP_DEFAULT_WIDTH);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; width: number } | null>(null);

  const clampPos = (x: number, y: number, w = width) => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return { x, y };
    const h = w / (16 / 9);
    const maxX = Math.max(8, parent.clientWidth - w - 8);
    const maxY = Math.max(8, parent.clientHeight - h - 8);
    return { x: Math.min(Math.max(x, 8), maxX), y: Math.min(Math.max(y, 8), maxY) };
  };

  const pinchDistance = () => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    el.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      dragOffsetRef.current = null; // pinch takes over from drag
      pinchRef.current = { dist: pinchDistance(), width };
      return;
    }
    const rect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragOffsetRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    if (!pos) setPos(clampPos(rect.left - parentRect.left, rect.top - parentRect.top));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2 && pinchRef.current) {
      const dist = pinchDistance();
      if (dist > 0 && pinchRef.current.dist > 0) {
        const nextWidth = Math.min(PIP_MAX_WIDTH, Math.max(PIP_MIN_WIDTH, pinchRef.current.width * (dist / pinchRef.current.dist)));
        setWidth(nextWidth);
        if (pos) setPos((p) => (p ? clampPos(p.x, p.y, nextWidth) : p));
      }
      return;
    }
    const drag = dragOffsetRef.current;
    const parent = ref.current?.parentElement;
    if (!drag || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    setPos(clampPos(e.clientX - parentRect.left - drag.dx, e.clientY - parentRect.top - drag.dy));
  };

  const endPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    ref.current?.releasePointerCapture(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size > 0) return; // still dragging/pinching with remaining pointer(s)
    dragOffsetRef.current = null;
    // snap to the nearest corner of the parent, like a floating call bubble
    setPos((p) => {
      if (!p) return p;
      const el = ref.current;
      const parent = el?.parentElement;
      if (!el || !parent) return p;
      const h = width / (16 / 9);
      const centerX = p.x + width / 2;
      const centerY = p.y + h / 2;
      const snappedX = centerX < parent.clientWidth / 2 ? 8 : Math.max(8, parent.clientWidth - width - 8);
      const snappedY = centerY < parent.clientHeight / 2 ? 8 : Math.max(8, parent.clientHeight - h - 8);
      return { x: snappedX, y: snappedY };
    });
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      style={{
        width,
        transition: pointersRef.current.size > 0 ? "none" : "left 0.2s ease, top 0.2s ease",
        ...(pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined),
      }}
      className={`absolute ${pos ? "" : defaultClassName} touch-none cursor-grab active:cursor-grabbing select-none ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

// ZoomableVideo: pinch-to-zoom + drag-to-pan the wrapped video content only —
// the gesture Zoom/Teams/Meet use to zoom into a remote video or a shared
// screen — instead of it falling through to the browser's own whole-page
// pinch-zoom (which used to grab the same two-finger gesture and zoom the
// controls along with everything else). Double-tap/double-click resets.
function ZoomableVideo({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const lastTapRef = useRef(0);

  const clampPos = (next: { x: number; y: number }, s: number) => {
    const el = ref.current;
    if (!el || s <= 1) return { x: 0, y: 0 };
    const maxX = (el.clientWidth * (s - 1)) / 2;
    const maxY = (el.clientHeight * (s - 1)) / 2;
    return { x: Math.min(Math.max(next.x, -maxX), maxX), y: Math.min(Math.max(next.y, -maxY), maxY) };
  };

  const reset = () => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  };

  const pinchDistance = () => {
    const pts = [...pointersRef.current.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    ref.current?.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      dragRef.current = null;
      pinchRef.current = { dist: pinchDistance(), scale };
    } else if (pointersRef.current.size === 1) {
      dragRef.current = { x: pos.x, y: pos.y, startX: e.clientX, startY: e.clientY };
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        reset();
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2 && pinchRef.current) {
      const d = pinchDistance();
      if (d > 0 && pinchRef.current.dist > 0) {
        const nextScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchRef.current.scale * (d / pinchRef.current.dist)));
        setScale(nextScale);
        setPos((p) => clampPos(p, nextScale));
      }
      return;
    }
    const drag = dragRef.current;
    if (!drag || scale <= 1) return;
    setPos(clampPos({ x: drag.x + (e.clientX - drag.startX), y: drag.y + (e.clientY - drag.startY) }, scale));
  };

  const endPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    ref.current?.releasePointerCapture(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragRef.current = null;
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={reset}
      className={`relative overflow-hidden touch-none select-none ${className ?? ""}`}
    >
      <div
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
          transition: pointersRef.current.size > 0 ? "none" : "transform 0.15s ease",
        }}
        className="w-full h-full"
      >
        {children}
      </div>
      {scale > 1 && (
        <button
          onClick={reset}
          className="absolute bottom-2 right-2 z-10 h-7 px-2.5 rounded-lg bg-black/60 text-white text-xs flex items-center gap-1 backdrop-blur"
          title="Reset zoom"
        >
          {Math.round(scale * 100)}%
        </button>
      )}
    </div>
  );
}

// Bars-style connection indicator (getStats()-driven, see lib/webrtc/netmonitor.ts)
// — a quick "is my call actually going to hold up" glance, same idea as the
// signal icon in Zoom/Teams/Meet.
function NetworkIndicator({ quality }: { quality: "good" | "fair" | "poor" }) {
  const bars = quality === "good" ? 3 : quality === "fair" ? 2 : 1;
  const color = quality === "good" ? "text-success" : quality === "fair" ? "text-warning" : "text-error";
  const label =
    quality === "good" ? "Good connection" : quality === "fair" ? "Fair connection — video quality may drop" : "Poor connection — video quality reduced";
  return (
    <span className={`flex items-end gap-0.5 ${color}`} title={label} aria-label={label}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`w-1 rounded-sm bg-current ${i <= bars ? "" : "opacity-25"}`} style={{ height: `${i * 4 + 2}px` }} />
      ))}
    </span>
  );
}

function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`.replace(/^0:/, "");
}

interface RecordTile {
  id: string;
  name: string;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
}

const RECORD_W = 1280;
const RECORD_H = 720;

// useCallRecording composites the call itself — one tile per participant,
// each drawn from its live video track onto a canvas, with every mic/remote
// audio track mixed through a shared WebAudio destination — into one
// MediaStream that MediaRecorder saves as a local .webm/.mp4. Entirely
// client-side and server never sees it, but unlike getDisplayMedia it needs
// no OS/browser screen-or-tab-share picker: it draws from the tracks the
// call already has, not from screen pixels.
// Note: fixed 2D grid layout redrawn from raw tracks, not a pixel-perfect
// copy of the on-screen UI (no chat drawer, no PiP drag position). Good
// enough for "a recording of the call"; a canvas that mirrors the exact
// on-screen layout would need a lot more plumbing for very little benefit.
function useCallRecording() {
  const me = useAuth((s) => s.me)!;
  const mode = useCalls((s) => s.mode);
  const localStream = useCalls((s) => s.localStream);
  const remoteStream = useCalls((s) => s.remoteStream);
  const remoteTracks = useCalls((s) => s.remoteTracks);
  const participants = useCalls((s) => s.participants);
  const peer = useCalls((s) => s.peer);
  const camOn = useCalls((s) => s.camOn);
const sharing = useCalls((s) => s.sharing);
  const localScreenStream = useCalls((s) => s.localScreenStream);

  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const outTracksRef = useRef<MediaStreamTrack[]>([]);
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const audioNodesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const tilesRef = useRef<RecordTile[]>([]);

  const tiles = useMemo<RecordTile[]>(() => {
    if (mode === "sfu") {
      return participants.map((p) => {
        const isMe = p.user_id === me.id;
        const myVideoTrack = sharing ? localScreenStream?.getVideoTracks()[0] : camOn ? localStream?.getVideoTracks()[0] : undefined;
        return {
          id: String(p.user_id),
          name: isMe ? `${p.display_name} (you)` : p.display_name,
          videoTrack: isMe ? myVideoTrack : p.screen ? remoteTracks[p.user_id]?.screen : p.video_on ? remoteTracks[p.user_id]?.cam : undefined,
          audioTrack: isMe ? localStream?.getAudioTracks()[0] : remoteTracks[p.user_id]?.mic,
        };
      });
    }
    const out: RecordTile[] = [
      {
        id: "me",
        name: `${me.display_name} (you)`,
        videoTrack: (sharing ? localScreenStream : camOn ? localStream : null)?.getVideoTracks()[0],
        audioTrack: localStream?.getAudioTracks()[0],
      },
    ];
    if (peer) {
      out.push({ id: "peer", name: peer.display_name, videoTrack: remoteStream?.getVideoTracks()[0], audioTrack: remoteStream?.getAudioTracks()[0] });
    }
    return out;
  }, [mode, participants, me.id, me.display_name, sharing, localScreenStream, camOn, localStream, remoteTracks, peer, remoteStream]);

  // Keep the hidden <video> pool (drawn each frame) and the WebAudio mixing
  // graph in sync with whoever's actually in the call right now.
  useEffect(() => {
    tilesRef.current = tiles;
    if (!recording) return;
    const wantVideo = new Set(tiles.filter((t) => t.videoTrack).map((t) => t.videoTrack!.id));
    for (const [id, el] of videoElsRef.current) {
      if (!wantVideo.has(id)) {
        el.srcObject = null;
        videoElsRef.current.delete(id);
      }
    }
    for (const t of tiles) {
      if (t.videoTrack && !videoElsRef.current.has(t.videoTrack.id)) {
        const el = document.createElement("video");
        el.muted = true;
        el.playsInline = true;
        el.srcObject = new MediaStream([t.videoTrack]);
        void el.play().catch(() => {});
        videoElsRef.current.set(t.videoTrack.id, el);
      }
    }
    const audioCtx = audioCtxRef.current;
    const dest = destRef.current;
    if (!audioCtx || !dest) return;
    const wantAudio = new Set(tiles.filter((t) => t.audioTrack).map((t) => t.audioTrack!.id));
    for (const [id, node] of audioNodesRef.current) {
      if (!wantAudio.has(id)) {
        node.disconnect();
        audioNodesRef.current.delete(id);
      }
    }
    for (const t of tiles) {
      if (!t.audioTrack || audioNodesRef.current.has(t.audioTrack.id)) continue;
      try {
        const src = audioCtx.createMediaStreamSource(new MediaStream([t.audioTrack]));
        src.connect(dest);
        audioNodesRef.current.set(t.audioTrack.id, src);
      } catch {
        /* track not live yet — next reconcile picks it up */
      }
    }
  }, [tiles, recording]);

  const cleanup = () => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      try {
        recorderRef.current.stop();
        return;
      } catch {
        /* proceed with teardown if stop threw */
      }
    }
    cancelAnimationFrame(rafRef.current);
    outTracksRef.current.forEach((t) => t.stop());
    outTracksRef.current = [];
    for (const el of videoElsRef.current.values()) el.srcObject = null;
    videoElsRef.current.clear();
    for (const node of audioNodesRef.current.values()) node.disconnect();
    audioNodesRef.current.clear();
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    destRef.current = null;
    canvasRef.current = null;
  };

  useEffect(() => cleanup, []);

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  const startRecording = async () => {
    setRecordError(null);
    try {
      if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
        throw new DOMException("canvas.captureStream unsupported", "NotSupportedError");
      }
      const canvas = document.createElement("canvas");
      canvas.width = RECORD_W;
      canvas.height = RECORD_H;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new DOMException("no 2d context", "NotSupportedError");
      canvasRef.current = canvas;

      const audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtxRef.current = audioCtx;
      destRef.current = dest;

      const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
      const audioTrack = dest.stream.getAudioTracks()[0];
      outTracksRef.current = [videoTrack, audioTrack];
      const outStream = new MediaStream([videoTrack, audioTrack]);

      const supportedType = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
      if (!supportedType) throw new DOMException("No supported recording format", "NotSupportedError");
      const mime = supportedType;
      const recorder = new MediaRecorder(outStream, { mimeType: mime });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
        a.download = `call-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        cleanup();
        recorderRef.current = null;
        if (isMountedRef.current) {
          setRecording(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start(1000);
      setRecording(true);

      const draw = () => {
        const cv = canvasRef.current;
        const c = cv?.getContext("2d");
        if (!cv || !c) return;
        c.fillStyle = "#18181b";
        c.fillRect(0, 0, cv.width, cv.height);
        const list = tilesRef.current;
        const n = Math.max(1, list.length);
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cellW = cv.width / cols;
        const cellH = cv.height / rows;
        list.forEach((tile, i) => {
          const x = (i % cols) * cellW;
          const y = Math.floor(i / cols) * cellH;
          const vidEl = tile.videoTrack ? videoElsRef.current.get(tile.videoTrack.id) : undefined;
          if (vidEl && vidEl.readyState >= 2) {
            const vw = vidEl.videoWidth || 16;
            const vh = vidEl.videoHeight || 9;
            const scale = Math.min(cellW / vw, cellH / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            c.drawImage(vidEl, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
          } else {
            c.fillStyle = "#3f3f46";
            c.fillRect(x + 4, y + 4, cellW - 8, cellH - 8);
            c.fillStyle = "#a1a1aa";
            c.font = `${Math.max(14, Math.round(cellH * 0.1))}px sans-serif`;
            c.textAlign = "center";
            c.textBaseline = "middle";
            c.fillText(tile.name, x + cellW / 2, y + cellH / 2);
          }
          const label = tile.name;
          c.font = "13px sans-serif";
          const labelW = Math.min(cellW - 16, c.measureText(label).width + 16);
          c.fillStyle = "rgba(0,0,0,0.6)";
          c.fillRect(x + 8, y + cellH - 30, labelW, 22);
          c.fillStyle = "#fff";
          c.textAlign = "left";
          c.textBaseline = "middle";
          c.fillText(label, x + 16, y + cellH - 19);
        });
        rafRef.current = requestAnimationFrame(draw);
      };
      rafRef.current = requestAnimationFrame(draw);
    } catch (err: any) {
      cleanup();
      if (err?.name !== "NotAllowedError") {
        console.error("startRecording failed:", err);
        setRecordError(err?.name === "NotSupportedError" ? "Recording isn't supported in this browser" : "Could not start recording");
      }
    }
  };

  return { recording, recordError, startRecording, stopRecording };
}

// DockBtn — one labeled control for the call dock. Label shows on sm+,
// icon-only on phones; 44px minimum in both axes.
function DockBtn({
  label,
  title,
  ariaLabel,
  onClick,
  disabled,
  tone = "idle",
  pressed,
  children,
}: {
  label: string;
  title: string;
  ariaLabel: string;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "idle" | "live" | "danger" | "warn";
  pressed?: boolean;
  children: React.ReactNode;
}) {
  const toneCls =
    tone === "live"
      ? "bg-brand text-white shadow-lg shadow-brand/30"
      : tone === "danger"
        ? "bg-error text-white hover:bg-error shadow-lg shadow-error/30"
        : tone === "warn"
          ? "bg-warning text-white shadow-lg shadow-warning/30"
          : "bg-elevated hover:bg-surface-hover text-white";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      className={`min-w-11 h-12 shrink-0 px-2 rounded-2xl flex flex-col items-center justify-center gap-1 border border-line/50 transition-all duration-150 cursor-pointer active:scale-90 disabled:opacity-40 disabled:cursor-not-allowed ${toneCls}`}
    >
      {children}
      <span className="hidden sm:block text-[9px] font-semibold leading-none tracking-wide">{label}</span>
    </button>
  );
}

function ControlsBar() {
  const { mode, micOn, camOn, sharing, inCallChat, showParticipants, participants, toggleMic, toggleCam, toggleScreen, setInCallChat, setShowParticipants, hangup, switchDevice, toast, setToast, toggleRaiseHand, raisedHands } = useCalls();
  const me = useAuth((s) => s.me)!;
  const handRaised = !!raisedHands[me.id];
  const myInfo = participants.find((p) => p.user_id === me.id);
  const canPresent = mode !== "sfu" || myInfo?.can_present !== false;
  const [showDevices, setShowDevices] = useState(false);
  const [devices, setDevices] = useState<DeviceList>({ mics: [], cams: [], speakers: [] });
  const [selectedMic, setSelectedMic] = useState(getPreferredDevice("mic") ?? "");
  const [selectedCam, setSelectedCam] = useState(getPreferredDevice("cam") ?? "");
  const [speaker, setSpeaker] = useState(getPreferredDevice("speaker") ?? "");
  const { recording, recordError, startRecording, stopRecording } = useCallRecording();
  const canCaptureScreen = useMemo(supportsScreenCapture, []);
  useEffect(() => {
    if (recordError) setToast(recordError);
  }, [recordError, setToast]);

  // Keep the screen awake for the whole call; the browser drops the lock
  // whenever the tab is hidden, so take it again when it comes back.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const take = async () => {
      try {
        if (document.visibilityState === "visible" && "wakeLock" in navigator) {
          lock = await (navigator as any).wakeLock.request("screen");
        }
      } catch {
        /* not supported or not allowed (needs HTTPS) */
      }
    };
    void take();
    const onVisible = () => {
      if (document.visibilityState === "visible") void take();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => {});
    };
  }, []);

  // Messages that arrive in this call's chat while the chat panel is closed.
  const callConvoKey = useCalls((s) => (s.peer ? `dm:${s.peer.id}` : s.group ? `g:${s.group.id}` : null));
  const chatUnread = useChats((s) => (callConvoKey ? s.unread[callConvoKey] ?? 0 : 0));
  useEffect(() => {
    // While the call covers the screen, the chat underneath isn't really
    // being read, so new messages should count as unread and notify.
    useChats.setState({ callCovering: !inCallChat });
    return () => useChats.setState({ callCovering: false });
  }, [inCallChat]);

  const pipSupported = typeof document !== "undefined" && "pictureInPictureEnabled" in document && (document as any).pictureInPictureEnabled;
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-call-video="remote"]'));
      const target = videos.find((v) => v.videoWidth > 0) ?? videos[0];
      if (!target) {
        setToast("There's no video to pop out yet");
        return;
      }
      await target.requestPictureInPicture();
    } catch {
      setToast("Couldn't open picture-in-picture");
    }
  };

  // Keyboard shortcuts: M mic, V camera, L leave, E chat. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "m") { e.preventDefault(); toggleMic(); }
      else if (k === "v") { e.preventDefault(); void toggleCam(); }
      else if (k === "l") { e.preventDefault(); hangup(); }
      else if (k === "e") { e.preventDefault(); setInCallChat(!useCalls.getState().inCallChat); }
      else if (k === "escape" && showDevices) { setShowDevices(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMic, toggleCam, hangup, setInCallChat, showDevices]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("vc:recording", { detail: recording }));
  }, [recording]);

  useEffect(() => {
    if (!showDevices) return;
    const refresh = () => {
      void listDevices(true).then(setDevices);
      setSelectedMic(getPreferredDevice("mic") ?? "");
      setSelectedCam(getPreferredDevice("cam") ?? "");
      setSpeaker(getPreferredDevice("speaker") ?? "");
    };
    refresh();
    return onDevicesChanged(refresh);
  }, [showDevices]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  const btn = (active: boolean) =>
    `min-w-11 h-12 shrink-0 px-2 rounded-2xl flex flex-col items-center justify-center gap-1 transition-all duration-150 cursor-pointer border ${
      active
        ? "bg-elevated hover:bg-surface-hover text-white active:scale-90 border-line/50"
        : "bg-error text-white hover:bg-error active:scale-90 shadow-lg shadow-error/30 border-transparent"
    }`;
  const btnLabel = "hidden sm:block text-[9px] font-semibold leading-none tracking-wide";

  return (
    <>
      {sharing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 rounded-full bg-success/95 text-white text-xs font-medium pl-3.5 pr-1.5 py-1.5 shadow-xl animate-modal-in" role="status">
          <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
          You're sharing your screen
          <button onClick={() => void toggleScreen()} className="rounded-full bg-white/20 hover:bg-white/30 px-3 py-1 font-semibold cursor-pointer">
            Stop
          </button>
        </div>
      )}
      {toast && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-elevated/90 text-white text-sm px-4 py-2 rounded-full z-20 max-w-[90%] text-center border border-line/50 shadow-xl backdrop-blur-md animate-modal-in" role="status">
          {toast}
        </div>
      )}
      <div className="relative flex items-center justify-center p-3 sm:p-5 shrink-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
        <div className="glass-dock flex items-center justify-center gap-1.5 sm:gap-2.5 px-3 sm:px-4 py-2 rounded-3xl max-w-full overflow-x-auto shadow-2xl">
          <button onClick={toggleMic} className={btn(micOn)} title={micOn ? "Mute (M)" : "Unmute (M)"} aria-label={micOn ? "Mute microphone" : "Unmute microphone"}>
            {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
            <span className={btnLabel}>{micOn ? "Mute" : "Unmute"}</span>
          </button>
          <button onClick={() => void toggleCam()} className={btn(camOn)} title={camOn ? "Turn camera off (V)" : "Turn camera on (V)"} aria-label={camOn ? "Turn camera off" : "Turn camera on"}>
            {camOn ? <VideoIcon className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
            <span className={btnLabel}>Camera</span>
          </button>
          <DockBtn
            label={sharing ? "Stop" : "Share"}
            title={!canCaptureScreen ? "Screen sharing is not supported on this device or browser" : !canPresent ? "Only the host or an approved presenter can share" : sharing ? "Stop sharing" : "Share screen"}
            ariaLabel={sharing ? "Stop screen sharing" : "Share screen"}
            tone={sharing ? "live" : "idle"}
            pressed={sharing}
            disabled={!sharing && (!canCaptureScreen || !canPresent)}
            onClick={() => {
              if (!canCaptureScreen) { setToast("Screen sharing isn't supported on this device/browser"); return; }
              if (!canPresent) { setToast("Only the host or an approved presenter can share their screen"); return; }
              void toggleScreen();
            }}
          >
            <MonitorUp className="h-5 w-5" />
          </DockBtn>
          {mode === "sfu" && (
            <DockBtn
              label={handRaised ? "Lower" : "Hand"}
              title={handRaised ? "Lower hand" : "Raise hand"}
              ariaLabel={handRaised ? "Lower hand" : "Raise hand"}
              tone={handRaised ? "warn" : "idle"}
              pressed={handRaised}
              onClick={toggleRaiseHand}
            >
              <Hand className={`h-5 w-5 ${handRaised ? "animate-pulse" : ""}`} />
            </DockBtn>
          )}
          <DockBtn
            label={recording ? "Stop" : "Record"}
            title={recording ? "Stop recording (saves to your device)" : "Record this call (saves to your device)"}
            ariaLabel={recording ? "Stop recording" : "Start recording"}
            tone={recording ? "danger" : "idle"}
            pressed={recording}
            onClick={() => void (recording ? stopRecording() : (async () => { setToast("Recording — saved to this device. Please let others know."); await startRecording(); })())}
          >
            {recording ? <Square className="h-5 w-5 animate-pulse" fill="currentColor" /> : <Circle className="h-5 w-5" />}
          </DockBtn>
          {mode === "sfu" && (
            <DockBtn
              label="People"
              title="Participants"
              ariaLabel="Toggle participants list"
              tone={showParticipants ? "live" : "idle"}
              pressed={showParticipants}
              onClick={() => { setShowParticipants(!showParticipants); if (!showParticipants) setInCallChat(false); }}
            >
              <Users className="h-5 w-5" />
            </DockBtn>
          )}
          <DockBtn
            label="Chat"
            title="In-call chat (E)"
            ariaLabel="Toggle in-call chat"
            tone={inCallChat ? "live" : "idle"}
            pressed={inCallChat}
            onClick={() => { setInCallChat(!inCallChat); if (!inCallChat) setShowParticipants(false); }}
          >
            <span className="relative">
              <MessageSquare className="h-5 w-5" />
              {chatUnread > 0 && !inCallChat && (
                <span className="absolute -top-2 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-error text-white text-[10px] font-bold leading-4 text-center animate-modal-in">
                  {chatUnread > 9 ? "9+" : chatUnread}
                </span>
              )}
            </span>
          </DockBtn>
          {pipSupported && (
            <DockBtn label="Pop out" title="Keep the video in a small floating window" ariaLabel="Picture in picture" tone="idle" pressed={false} onClick={() => void togglePip()}>
              <PictureInPicture2 className="h-5 w-5" />
            </DockBtn>
          )}
          <div className="relative shrink-0">
            <button
              onClick={() => setShowDevices((v) => !v)}
              className="min-w-11 h-12 px-2 rounded-2xl bg-elevated hover:bg-surface-hover text-white border border-line/50 flex flex-col items-center justify-center gap-1 transition-all duration-150 active:scale-90 cursor-pointer"
              title="Devices"
              aria-label="Choose devices"
              aria-expanded={showDevices}
            >
              <Settings2 className="h-5 w-5" />
              <span className={btnLabel}>Devices</span>
            </button>
            {showDevices && createPortal(
              <>
                <div className="fixed inset-0 z-[55]" onClick={() => setShowDevices(false)} />
                <div role="dialog" aria-modal="true" aria-label="Audio and video settings" className="fixed bottom-24 left-1/2 -translate-x-1/2 w-[calc(100vw-2rem)] max-w-72 rounded-2xl bg-elevated/95 border border-line/80 p-4 space-y-3 shadow-2xl backdrop-blur-xl z-[60] animate-modal-in max-h-[60vh] overflow-y-auto">
                  <p className="text-xs font-semibold text-ink-secondary border-b border-line pb-2">Audio & Video Settings</p>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Microphone</label>
                    <select
                      aria-label="Microphone"
                      className="w-full rounded-xl bg-elevated border border-line text-white text-xs px-2.5 py-2 outline-none focus:ring-2 focus:ring-brand"
                      value={selectedMic}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSelectedMic(id);
                        void switchDevice("mic", id);
                      }}
                    >
                      <option value="">Default Microphone</option>
                      {devices.mics.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic (${d.deviceId.slice(0, 5)})`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Camera</label>
                    <select
                      aria-label="Camera"
                      className="w-full rounded-xl bg-elevated border border-line text-white text-xs px-2.5 py-2 outline-none focus:ring-2 focus:ring-brand"
                      value={selectedCam}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSelectedCam(id);
                        void switchDevice("cam", id);
                      }}
                    >
                      <option value="">Default Camera</option>
                      {devices.cams.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera (${d.deviceId.slice(0, 5)})`}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-ink-muted block mb-1">Speaker</label>
                    <select
                      aria-label="Speaker"
                      className="w-full rounded-xl bg-elevated border border-line text-white text-xs px-2.5 py-2 outline-none focus:ring-2 focus:ring-brand"
                      value={speaker}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSpeaker(id);
                        setPreferredDevice("speaker", id || undefined);
                      }}
                    >
                      <option value="">Default Speaker</option>
                      {devices.speakers.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker (${d.deviceId.slice(0, 5)})`}</option>
                      ))}
                    </select>
                  </div>
                  {devices.cams.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const ids = devices.cams.map((d) => d.deviceId);
                        const i = ids.indexOf(selectedCam);
                        const next = ids[(i + 1) % ids.length];
                        setSelectedCam(next);
                        void switchDevice("cam", next);
                      }}
                      className="w-full flex items-center justify-center gap-1.5 rounded-xl bg-elevated hover:bg-surface-hover text-white text-xs px-3 py-2 transition"
                    >
                      <RefreshCcw className="h-3.5 w-3.5" /> Flip camera
                    </button>
                  )}
                </div>
              </>,
              document.body,
            )}
          </div>
          <button
            onClick={hangup}
            className="min-w-11 h-12 px-3 sm:px-4 shrink-0 rounded-2xl bg-error hover:bg-error text-white flex flex-col items-center justify-center gap-1 font-semibold shadow-lg shadow-error/35 active:scale-95 transition-all duration-150 cursor-pointer"
            title="Hang up (L)"
            aria-label="Hang up"
          >
            <PhoneOff className="h-5 w-5" />
            <span className="hidden sm:block text-[9px] font-bold tracking-wide leading-none">LEAVE</span>
          </button>
          <span className="sr-only">{mode}</span>
        </div>
      </div>
    </>
  );
}

function SfuTile({
  info,
  isMe,
  stream,
  track,
  isSpeaking,
}: {
  info: ParticipantInfo;
  isMe: boolean;
  stream: MediaStream | null;
  track?: MediaStreamTrack;
  isSpeaking?: boolean;
}) {
  const me = useAuth((s) => s.me)!;
  const myInfo = useCalls((s) => s.participants.find((p) => p.user_id === me.id));
  const muteParticipant = useCalls((s) => s.muteParticipant);
  const camOn = useCalls((st) => st.camOn);
  const sharing = useCalls((st) => st.sharing);
  const handRaised = useCalls((st) => !!st.raisedHands[info.user_id]);
  const showVideo = !!(track ?? stream) && (isMe ? (camOn || sharing) : info.video_on);

  return (
    <div
      className={`relative bg-elevated/90 border rounded-2xl overflow-hidden aspect-video flex items-center justify-center group transition-all duration-300 shadow-lg ${
        isSpeaking ? "speaking-glow ring-2 ring-brand shadow-2xl shadow-brand/25" : "border-line/50"
      }`}
    >
      {showVideo ? (
        track ? (
          <TrackVideo track={track} muted={isMe} className="w-full h-full object-contain" />
        ) : (
          <Video stream={stream} muted={isMe} mirror={isMe && !sharing} className="w-full h-full object-contain" />
        )
      ) : null}
      {!showVideo && (
        <div className="relative">
          <Avatar name={info.display_name} id={info.user_id} fileId={info.avatar_file_id} size="xl" />
        </div>
      )}
      {handRaised && (
        <span className="absolute top-3 left-3 h-8 w-8 rounded-full bg-warning text-white flex items-center justify-center shadow-lg border border-white/20">
          <Hand className="h-4 w-4" />
        </span>
      )}
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 bg-page/75 text-white text-xs font-medium px-3.5 py-1.5 rounded-full max-w-[85%] backdrop-blur-xl border border-white/15 shadow-md">
        {info.host && <Crown className="h-3.5 w-3.5 text-warning shrink-0" />}
        {info.muted && <MutedBadge className="h-3.5 w-3.5 text-error shrink-0" />}
        {isSpeaking && (
          <span className="flex items-center gap-0.5 h-3 px-0.5 text-info shrink-0" aria-label="Speaking">
            <span className="w-0.5 h-2 bg-info rounded-full animate-pulse" />
            <span className="w-0.5 h-3 bg-brand rounded-full animate-pulse [animation-delay:0.15s]" />
            <span className="w-0.5 h-1.5 bg-brand rounded-full animate-pulse [animation-delay:0.3s]" />
          </span>
        )}
        <span className="truncate">{info.display_name}{isMe ? " (you)" : ""}</span>
      </div>
      {!isMe && myInfo?.host && !info.muted && (
        <button
          onClick={() => muteParticipant(info.user_id)}
          className="absolute top-3 right-3 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100 focus:opacity-100 transition bg-black/70 hover:bg-error text-white text-xs px-2.5 py-1.5 rounded-full flex items-center gap-1 backdrop-blur-md border border-line/50 cursor-pointer"
          title="Mute participant (host)"
          aria-label={`Mute ${info.display_name}`}
        >
          <MicOff className="h-3 w-3" /> Mute
        </button>
      )}
    </div>
  );
}

function MiniCallCard() {
  const { mode, peer, group, micOn, camOn, setMinimized, toggleMic, toggleCam, hangup, startedAt, wsReconnecting, mediaReconnecting, networkQuality } = useCalls();
  const elapsed = useElapsed(startedAt);
  const title = mode === "p2p" ? peer?.display_name : group?.name ?? "Group call";
  const reconnecting = wsReconnecting || mediaReconnecting;

  return (
    <div className="fixed bottom-20 md:bottom-6 right-4 z-40 w-72 md:w-80 rounded-2xl bg-elevated/95 border border-line shadow-2xl p-3 text-white backdrop-blur flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2.5 w-2.5 rounded-full animate-pulse shrink-0 ${reconnecting ? "bg-warning" : "bg-success"}`} />
          <div className="min-w-0">
            <p className="text-xs font-semibold truncate">{title}</p>
            <p className="text-[10px] text-ink-muted flex items-center gap-1.5 tabular-nums">
              {reconnecting ? "Reconnecting…" : elapsed || "Connected"}
              {!reconnecting && <NetworkIndicator quality={networkQuality} />}
            </p>
          </div>
        </div>
        <button
          onClick={() => setMinimized(false)}
          className="h-9 w-9 rounded-lg hover:bg-surface-hover flex items-center justify-center text-ink-secondary hover:text-white shrink-0"
          title="Maximize call"
          aria-label="Maximize call"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center justify-center gap-2 pt-1 border-t border-line">
        <button
          onClick={toggleMic}
          className={`h-9 w-9 rounded-full flex items-center justify-center text-xs ${
            micOn ? "bg-elevated hover:bg-surface-hover text-white" : "bg-error text-white"
          }`}
          title={micOn ? "Mute" : "Unmute"}
        >
          {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </button>
        <button
          onClick={() => void toggleCam()}
          className={`h-9 w-9 rounded-full flex items-center justify-center text-xs ${
            camOn ? "bg-elevated hover:bg-surface-hover text-white" : "bg-error text-white"
          }`}
          title={camOn ? "Camera off" : "Camera on"}
        >
          {camOn ? <VideoIcon className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </button>
        <button
          onClick={hangup}
          className="h-9 w-9 rounded-full bg-error hover:bg-error flex items-center justify-center text-white"
          title="End call"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function CallOverlay() {
  const me = useAuth((s) => s.me)!;
  const s = useCalls();
  const elapsed = useElapsed(s.startedAt);
  const [activeSpeakers, setActiveSpeakers] = useState<Record<number, boolean>>({});
  const [isRecording, setIsRecording] = useState(false);
  useEffect(() => {
    const onRec = (e: Event) => setIsRecording(!!(e as CustomEvent).detail);
    window.addEventListener("vc:recording", onRec);
    return () => window.removeEventListener("vc:recording", onRec);
  }, []);

  // handle in-call chat sync with active conversation in chats store
  useEffect(() => {
    if (!s.inCallChat) return;
    if (s.mode === "p2p" && s.peer) {
      useChats.getState().openDm(s.peer.id);
    } else if (s.mode === "sfu" && s.group) {
      useChats.getState().openGroup(s.group.id);
    }
  }, [s.inCallChat, s.mode, s.peer, s.group]);

  const myTracks = useMemo(() => {
    const out: React.ReactElement[] = [];
    for (const [uidStr, tracks] of Object.entries(s.remoteTracks)) {
      const uid = Number(uidStr);
      if (tracks.mic && uid !== me.id) {
        out.push(
          <RemoteAudio
            key={`a-${uid}`}
            track={tracks.mic}
            onVolume={(vol) => {
              setActiveSpeakers((prev) => ({ ...prev, [uid]: vol > 15 }));
            }}
          />
        );
      }
    }
    return out;
  }, [s.remoteTracks, me.id]);

  if (s.status === "idle") return null;
  if (s.minimized) return <MiniCallCard />;

  // screen share (sfu): find the sharing participant's screen track
  const screenSharer = s.participants.find((p) => p.screen);
  const remoteScreenTrack = screenSharer && screenSharer.user_id !== me.id
    ? s.remoteTracks[screenSharer.user_id]?.screen
    : undefined;
  const screenStream = screenSharer?.user_id === me.id ? s.localScreenStream : null;

  const roomTitle = s.mode === "p2p" ? s.peer?.display_name : s.privateRoom?.name ?? s.group?.name ?? "Group call";

  const connectingView = (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6">
      {s.peer && (
        <div className="ring-pulse rounded-full">
          <Avatar name={s.peer.display_name} id={s.peer.id} fileId={s.peer.avatar_file_id} size="xl" />
        </div>
      )}
      <div className="text-center">
        <p className="text-lg font-semibold text-white">{roomTitle}</p>
        <p className="text-sm text-ink-muted flex items-center gap-2 justify-center mt-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {s.status === "outgoing" ? (s.ringing ? "Ringing…" : "Calling…") : s.status === "waiting-approval" ? "Waiting for the host to let you in…" : "Connecting…"}
        </p>
      </div>
      <button
        onClick={() => s.hangup()}
        className="h-11 px-5 rounded-full bg-error hover:bg-error text-white text-sm font-semibold shadow-lg active:scale-95 transition cursor-pointer"
      >
        Cancel
      </button>
    </div>
  );

  // touch-pan-x/y (not touch-none) keeps native scrolling working in the
  // participant grid/chat/controls row while stopping the browser's own
  // pinch-to-zoom from grabbing two-finger gestures meant for a video's own
  // zoom (below) or the PiP's resize handle.
  return (
    <div className="fixed inset-0 z-50 bg-page flex flex-col touch-pan-x touch-pan-y">
      {/* header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 text-white border-b border-line/50 shrink-0 bg-page/70 backdrop-blur-xl z-20">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-2.5 w-2.5 rounded-full bg-success shadow-sm shadow-success/50 animate-pulse shrink-0" />
          <p className="font-semibold text-sm tracking-tight truncate">{roomTitle}</p>
          <span className="text-xs font-mono tabular-nums font-medium text-ink-secondary bg-white/10 border border-line/50 px-2.5 py-0.5 rounded-full shrink-0">{elapsed || "Calling…"}</span>
          {isRecording && (
            <span className="text-[11px] font-bold text-white bg-error px-2.5 py-0.5 rounded-full flex items-center gap-1.5 animate-pulse shrink-0" role="status" aria-label="Recording in progress">
              <span className="h-1.5 w-1.5 rounded-full bg-white" /> REC
            </span>
          )}
          {s.mode === "sfu" && (
            <span className="text-xs text-ink-muted bg-elevated/80 px-2.5 py-0.5 rounded-full border border-line/50 hidden sm:inline-block">
              {s.participants.length} {s.participants.length === 1 ? "participant" : "participants"}
            </span>
          )}
          {s.status === "active" && <NetworkIndicator quality={s.networkQuality} />}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => s.setMinimized(true)}
            className="h-10 w-10 sm:h-8 sm:w-8 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-xl bg-white/5 hover:bg-white/15 border border-line/50 text-ink-muted hover:text-white flex items-center justify-center transition cursor-pointer"
            title="Minimize call"
            aria-label="Minimize call"
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {(s.wsReconnecting || s.mediaReconnecting) && s.status === "active" && (
        <div className="px-4 py-1.5 bg-warning text-black text-xs font-semibold flex items-center justify-center gap-1.5 shrink-0">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reconnecting…
        </div>
      )}

      {/* body */}
      <div className="flex-1 flex min-h-0 relative">
        <div className="flex-1 flex flex-col min-w-0 relative">
          {s.status === "outgoing" || s.status === "connecting" || s.status === "waiting-approval" ? (
            connectingView
          ) : s.mode === "p2p" ? (
            <div className="flex-1 relative min-h-0 bg-elevated flex items-center justify-center">
              {s.remoteStream?.getVideoTracks().length ? (
                <ZoomableVideo className="w-full h-full">
                  <Video stream={s.remoteStream} className="w-full h-full object-contain" />
                </ZoomableVideo>
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                  <Avatar name={s.peer?.display_name ?? "?"} id={s.peer?.id ?? 0} fileId={s.peer?.avatar_file_id} size="xl" />
                  <p className="text-sm text-ink-muted">{s.peer?.display_name}</p>
                </div>
              )}
              {s.remoteMuted && (
                <div className="absolute top-4 left-4 bg-error/90 text-white text-xs px-2.5 py-1 rounded-lg flex items-center gap-1.5 shadow-lg backdrop-blur">
                  <MutedBadge className="h-3.5 w-3.5" />
                  <span>{s.peer?.display_name ?? "Peer"} is muted</span>
                </div>
              )}
              {/* self PiP — draggable, drag it anywhere over the call view */}
              {(s.sharing ? s.localScreenStream : s.localStream)?.getVideoTracks().length && (s.sharing || s.camOn) ? (
                <DraggablePiP defaultClassName="bottom-4 right-4" className="aspect-video rounded-xl overflow-hidden border-2 border-white/20 shadow-xl bg-elevated">
                  <Video
                    stream={s.sharing ? s.localScreenStream : s.localStream}
                    muted
                    mirror={!s.sharing}
                    className="w-full h-full object-contain"
                  />
                  <span className="absolute bottom-1 left-2 text-[10px] text-white/80 bg-elevated/80 px-1.5 rounded">You</span>
                </DraggablePiP>
              ) : null}
            </div>
          ) : (
            <div className="flex-1 min-h-0 p-3 overflow-y-auto">
              {screenSharer && (screenStream || remoteScreenTrack) ? (
                <div className="h-full flex flex-col gap-3">
                  <div className="flex-1 min-h-0 bg-elevated rounded-xl overflow-hidden relative">
                    <ZoomableVideo className="w-full h-full">
                      {remoteScreenTrack ? (
                        <TrackVideo track={remoteScreenTrack} className="w-full h-full object-contain" />
                      ) : (
                        <Video stream={screenStream} muted className="w-full h-full object-contain" />
                      )}
                    </ZoomableVideo>
                    <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded-md backdrop-blur">
                      {screenSharer.display_name}'s screen
                    </div>
                  </div>
                  <div className="flex gap-2 overflow-x-auto shrink-0 pb-1">
                    {s.participants.map((p) => (
                      <div key={p.user_id} className="w-44 shrink-0">
                        <SfuTile
                          info={p}
                          isMe={p.user_id === me.id}
                          stream={p.user_id === me.id ? s.localStream : null}
                          track={p.user_id === me.id ? undefined : s.remoteTracks[p.user_id]?.cam}
                          isSpeaking={activeSpeakers[p.user_id]}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={`grid grid-cols-1 sm:grid-cols-2 ${s.participants.length > 4 ? "lg:grid-cols-3 xl:grid-cols-4" : "lg:grid-cols-3"} gap-3 h-full content-start overflow-y-auto`}>
                  {s.participants.map((p) => (
                    <SfuTile
                      key={p.user_id}
                      info={p}
                      isMe={p.user_id === me.id}
                      stream={p.user_id === me.id ? s.localStream : null}
                      track={p.user_id === me.id ? undefined : s.remoteTracks[p.user_id]?.cam}
                      isSpeaking={activeSpeakers[p.user_id]}
                    />
                  ))}
                  {s.participants.length === 0 && (
                    <p className="text-ink-muted text-sm text-center">Joining…</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* participants sidebar */}
        {s.mode === "sfu" && s.showParticipants && <ParticipantsSidebar activeSpeakers={activeSpeakers} />}

        {/* in-call chat slide-out drawer */}
        {s.inCallChat && (
          <aside aria-label="In-call chat" className="absolute inset-y-0 right-0 w-full sm:static sm:w-80 md:w-96 shrink-0 border-l border-line bg-surface flex flex-col z-20 shadow-2xl text-ink">
            <div className="flex items-center justify-between px-4 py-3 border-b border-line font-semibold text-sm">
              <span>In-call Chat</span>
              <button
                onClick={() => s.setInCallChat(false)}
                className="h-10 w-10 sm:h-9 sm:w-9 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-lg text-ink-muted hover:text-ink hover:bg-surface-hover flex items-center justify-center cursor-pointer"
                title="Close chat"
                aria-label="Close in-call chat"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">
              <ChatPanel onBack={() => s.setInCallChat(false)} />
            </div>
          </aside>
        )}
      </div>

      {/* hidden remote audio (sfu) */}
      {myTracks}

      <ControlsBar />
    </div>
  );
}

