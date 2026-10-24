import { uuid } from "./util";

type Handler = (data: any) => void;

// Stable per-browser identifier, persisted in localStorage. Lets the server
// tell "this same browser reconnecting" apart from "a different device
// signed in" so it knows whether to swap sessions quietly or kick the old
// one with an explanation. Two tabs in the same browser share this id.
let fallbackDeviceID: string | null = null;

export function deviceID(): string {
  const key = "vc.deviceId";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = uuid();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    // Storage blocked (private mode): stable for this page load at least.
    return (fallbackDeviceID ??= uuid());
  }
}

/**
 * Singleton WebSocket with automatic reconnection and typed event dispatch.
 * All realtime traffic (presence, chat, calls, SFU signaling) flows through it.
 */
class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private backoff = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wantConnected = false;
  // Set when the server reports this exact connection was replaced by
  // another tab/window of the same browser (see hub.go's "ws:replaced").
  // Distinct from a plain drop: auto-reconnecting here would just fight the
  // newer tab for the same account slot forever, so this tab stops trying
  // on its own - connect() (e.g. from a "use this tab instead" button)
  // clears it and resumes normally.
  replaced = false;

  connect() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.wantConnected = true;
    this.replaced = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?device=${deviceID()}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.backoff = 1000;
      this.emit("ws:open", null);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg && typeof msg.type === "string") {
          if (msg.type === "ws:replaced") {
            // Stop before the imminent onclose can schedule a reconnect.
            this.wantConnected = false;
            this.replaced = true;
          }
          this.emit(msg.type, msg.data);
        }
      } catch {
        /* malformed frame */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.emit("ws:close", null);
      if (this.wantConnected) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* already closing */ }
    };
  }

  constructor() {
    // Network back or tab shown again: retry now instead of waiting out a
    // backoff of up to 15s.
    const retryNow = () => {
      if (!this.wantConnected || this.ws || document.hidden) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.backoff = 1000;
      this.connect();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", retryNow);
  }

  private scheduleReconnect() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  disconnect() {
    this.wantConnected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(type: string, data?: unknown) {
    if (!this.connected) return false;
    try {
      this.ws!.send(JSON.stringify({ type, data: data ?? {} }));
      return true;
    } catch {
      return false;
    }
  }

  on(type: string, handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  private emit(type: string, data: any) {
    this.handlers.get(type)?.forEach((h) => {
      try {
        h(data);
      } catch (err) {
        console.error(`ws handler for ${type} failed`, err);
      }
    });
  }
}

export const ws = new WSClient();
