import { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Users,
  Phone,
  Settings as SettingsIcon,
  Shield,
  LogOut,
  Moon,
  Sun,
  WifiOff,
  RefreshCw,
  KeyRound,
  MoreHorizontal,
  X,
  Palette,
  Bell,
} from "lucide-react";
import { useAuth } from "../store/auth";
import { useChats } from "../store/chats";
import { usePresence } from "../store/presence";
import { ws } from "../lib/ws";
import { getNotificationPermissionStatus, notificationsSupported, requestNotificationPermission } from "../lib/media";
import { toast } from "../store/toast";
import { KeyBackupRestorePrompt } from "../components/KeyBackup";
import { QuickSwitcher } from "../components/QuickSwitcher";
import { Avatar, PresenceDot, Menu, MenuItem } from "../components/ui";
import { THEMES, savePreferencesToDb, type ThemeId } from "../lib/theme";
import Chats from "./Chats";
import Directory from "./Directory";
import CallsHistory from "./CallsHistory";
import Rooms from "./Rooms";
import Admin from "./Admin";
import Settings from "./Settings";

type View = "chats" | "directory" | "calls" | "rooms" | "admin" | "settings";

function parseHash(): View {
  const hash = window.location.hash.replace("#", "");
  if (hash === "admin" || hash.startsWith("admin/")) return "admin";
  if (hash === "chats" || hash === "directory" || hash === "calls" || hash === "rooms" || hash === "settings") {
    return hash as View;
  }
  return "chats";
}

export default function Shell() {
  const me = useAuth((s) => s.me)!;
  const setMe = useAuth((s) => s.setMe);
  const logout = useAuth((s) => s.logout);
  const unread = useChats((s) => s.unread);

  const [view, setView] = useState<View>(parseHash);
  const [connected, setConnected] = useState(ws.connected);

  const currentThemeId: ThemeId = me.preferences?.theme ?? "dark";
  const currentTheme = THEMES.find((t) => t.id === currentThemeId) ?? THEMES[0];

  const pickTheme = async (themeId: ThemeId) => {
    const updated = await savePreferencesToDb({ theme: themeId });
    setMe({ ...me, preferences: updated });
  };

  const cycleTheme = async () => {
    const order: ThemeId[] = ["dark", "light", "midnight", "sunset", "forest", "cyberpunk"];
    const nextIdx = (order.indexOf(currentThemeId) + 1) % order.length;
    await pickTheme(order[nextIdx]);
  };

  const totalUnread = useMemo(() => {
    return Object.values(unread).reduce((sum, n) => sum + (n || 0), 0);
  }, [unread]);

  // Unread count on the browser tab and the installed app's icon, so a
  // background tab still shows there's something new.
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Vision Call` : "Vision Call";
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    (totalUnread > 0 ? nav.setAppBadge?.(totalUnread) : nav.clearAppBadge?.())?.catch(() => {});
  }, [totalUnread]);

  useEffect(() => {
    const onHashChange = () => {
      setView(parseHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const changeView = (v: View) => {
    setView(v);
    window.location.hash = v;
  };

  const [replaced, setReplaced] = useState(ws.replaced);
  useEffect(() => {
    const check = () => {
      setConnected(ws.connected);
      setReplaced(ws.replaced);
    };
    check();
    const offOpen = ws.on("ws:open", check);
    const offClose = ws.on("ws:close", check);
    const offReplaced = ws.on("ws:replaced", check);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    return () => {
      offOpen();
      offClose();
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      offReplaced();
    };
  }, []);

  const myStatus = usePresence((s) => s.myStatus);
  const setMyStatus = usePresence((s) => s.setMyStatus);

  const awayRef = useRef(false);
  // A status picked by hand (Away/DND) sticks until changed by hand; only
  // the automatic idle-away follows mouse and keyboard activity.
  const manualRef = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const send = (status: "online" | "away") => {
      if (manualRef.current || usePresence.getState().myStatus === "dnd") return;
      if (awayRef.current !== (status === "away")) {
        awayRef.current = status === "away";
        usePresence.setState({ myStatus: status });
        ws.send("presence:update", { status });
      }
    };
    let lastActivity = 0;
    const reset = () => {
      const now = Date.now();
      if (now - lastActivity < 2000) return;
      lastActivity = now;
      send("online");
      clearTimeout(timer);
      timer = setTimeout(() => send("away"), 5 * 60 * 1000);
    };
    const events = ["mousemove", "keydown", "pointerdown", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);

  const pickStatus = (status: "online" | "away" | "dnd") => {
    awayRef.current = status === "away";
    manualRef.current = status !== "online";
    setMyStatus(status);
  };

  const statusLabel = { online: "Online", away: "Away", dnd: "Do Not Disturb" }[myStatus];

  const navItems: { id: View; icon: typeof MessageSquare; label: string; badge?: number }[] = [
    { id: "chats", icon: MessageSquare, label: "Chats", badge: totalUnread },
    { id: "directory", icon: Users, label: "Directory" },
    { id: "calls", icon: Phone, label: "Calls" },
    { id: "rooms", icon: KeyRound, label: "Rooms" },
    ...(me.role === "admin" ? [{ id: "admin" as View, icon: Shield, label: "Admin" }] : []),
    { id: "settings", icon: SettingsIcon, label: "Settings" },
  ];

  // Mobile gets 4 primary tabs + a More sheet (3–5 item rule); the sheet
  // reuses the same views so no feature moves or disappears.
  const primaryMobile = navItems.filter((n) => n.id === "chats" || n.id === "directory" || n.id === "calls" || n.id === "rooms");
  const moreMobile = navItems.filter((n) => n.id === "admin" || n.id === "settings");
  // Browsers only show the permission prompt after a click, so offer it.
  const [askNotify, setAskNotify] = useState(() => {
    try {
      return notificationsSupported() && getNotificationPermissionStatus() === "default" && localStorage.getItem("vc.notifyAsked") !== "1";
    } catch {
      return false;
    }
  });
  const dismissNotify = () => {
    setAskNotify(false);
    try {
      localStorage.setItem("vc.notifyAsked", "1");
    } catch {
      /* ignore */
    }
  };
  const enableNotify = async () => {
    const result = await requestNotificationPermission();
    dismissNotify();
    if (result === "granted") toast.success("Notifications are on.");
    else toast.info("Notifications are off. You can turn them on in your browser's site settings.");
  };

  const [showMore, setShowMore] = useState(false);
  const moreActive = view === "admin" || view === "settings";

  return (
    <div className="flex flex-col h-full app-shell text-ink">
      <KeyBackupRestorePrompt userID={me.id} />
      <QuickSwitcher />
      {askNotify && (
        <div className="bg-brand/10 border-b border-brand/20 text-ink text-xs px-4 py-2 flex items-center justify-center gap-3 font-medium shrink-0 z-50 animate-fade-in">
          <Bell className="h-3.5 w-3.5 text-brand" />
          <span>Get notified about new messages and calls.</span>
          <button onClick={() => void enableNotify()} className="font-semibold text-brand hover:text-brand-hover underline underline-offset-2 cursor-pointer">
            Turn on
          </button>
          <button onClick={dismissNotify} aria-label="Dismiss" className="text-ink-muted hover:text-ink cursor-pointer">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {/* Reconnecting banners */}
      {!connected && replaced && (
        <div className="bg-surface/95 backdrop-blur-sm text-ink-secondary text-xs px-4 py-2 flex items-center justify-center gap-2 font-medium shrink-0 z-50 border-b border-line">
          <WifiOff className="h-3.5 w-3.5 text-ink-muted" />
          <span>This account was opened in another tab — this one paused.</span>
          <button
            onClick={() => ws.connect()}
            className="ml-2 font-semibold text-brand hover:text-brand-hover underline underline-offset-2 flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" /> Use This Tab Instead
          </button>
        </div>
      )}
      {!connected && !replaced && (
        <div className="bg-amber-950/80 border-b border-amber-800/50 text-amber-200 text-xs px-4 py-2 flex items-center justify-center gap-2 font-medium shrink-0 z-50">
          <WifiOff className="h-3.5 w-3.5 animate-pulse" />
          <span>Realtime connection lost. Reconnecting…</span>
          <button
            onClick={() => ws.connect()}
            className="ml-2 font-semibold text-amber-300 hover:text-amber-100 underline underline-offset-2 flex items-center gap-1.5 transition cursor-pointer"
          >
            <RefreshCw className="h-3 w-3" /> Retry Now
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex w-14 lg:w-56 flex-col app-sidebar border-r border-line bg-sidebar text-ink shrink-0 select-none">
          {/* Logo */}
          <div className="flex items-center gap-3 px-3 h-14 border-b border-line shrink-0">
            <div className="relative h-8 w-8 rounded-lg bg-brand flex items-center justify-center text-white shadow-md shrink-0">
              <span className="font-display font-bold text-sm">V</span>
            </div>
            <span className="hidden lg:block text-sm font-bold font-display tracking-tight text-ink truncate">
              Vision Call
            </span>
          </div>

          {/* Nav items */}
          <nav aria-label="Workspace" className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
            <p className="hidden lg:block px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-muted" aria-hidden="true">
              Workspace
            </p>
            {navItems.filter((n) => n.id === "chats" || n.id === "directory" || n.id === "calls" || n.id === "rooms").map(({ id, icon: Icon, label, badge }) => (
              <button
                key={id}
                onClick={() => changeView(id)}
                title={label}
                aria-label={badge ? `${label}, ${badge} unread` : label}
                aria-current={view === id ? "page" : undefined}
                className={`relative w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150 cursor-pointer ${
                  view === id
                    ? "bg-brand/10 text-brand font-semibold"
                    : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
                }`}
              >
                {view === id && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full bg-brand" />
                )}
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon className={`h-5 w-5 shrink-0 ${view === id ? "text-brand" : "text-ink-muted"}`} />
                  <span className="hidden lg:block text-sm">{label}</span>
                </div>
                {badge != null && badge > 0 && (
                  <span className="rounded-full bg-brand text-white text-[10px] font-bold px-1.5 min-w-5 text-center leading-4 py-px">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </button>
            ))}
            <p className="hidden lg:block px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-muted" aria-hidden="true">
              Manage
            </p>
            <div className="mx-2 my-2 h-px bg-line lg:hidden" aria-hidden="true" />
            {navItems.filter((n) => n.id === "admin" || n.id === "settings").map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => changeView(id)}
                title={label}
                aria-label={label}
                aria-current={view === id ? "page" : undefined}
                className={`relative w-full flex items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-150 cursor-pointer ${
                  view === id
                    ? "bg-brand/10 text-brand font-semibold"
                    : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
                }`}
              >
                {view === id && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full bg-brand" />
                )}
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon className={`h-5 w-5 shrink-0 ${view === id ? "text-brand" : "text-ink-muted"}`} />
                  <span className="hidden lg:block text-sm">{label}</span>
                </div>
              </button>
            ))}
          </nav>

          {/* Bottom controls */}
          <div className="px-2 py-2 border-t border-line space-y-0.5">
            {/* Theme picker */}
            <Menu
              align="start"
              placement="up"
              className="block w-full"
              trigger={({ toggle, ref, open }) => (
                <button
                  ref={ref}
                  onClick={toggle}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-label={`Theme: ${currentTheme.name}. Change theme`}
                  className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-ink-secondary hover:bg-surface-hover hover:text-ink transition duration-150 cursor-pointer"
                  title="Choose theme"
                >
                  <Palette className="h-5 w-5 text-brand shrink-0" />
                  <div className="hidden lg:flex items-center justify-between flex-1 min-w-0">
                    <span className="text-sm font-medium truncate">{currentTheme.name.split(" ")[0]}</span>
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-line shrink-0"
                      style={{ backgroundColor: currentTheme.accentHex }}
                    />
                  </div>
                </button>
              )}
            >
              <div className="px-3 py-1.5 mb-1 border-b border-line">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted">Select theme</p>
              </div>
              {THEMES.map((t) => (
                <MenuItem key={t.id} onClick={() => void pickTheme(t.id)}>
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: t.accentHex }} />
                  <span className={currentThemeId === t.id ? "font-semibold text-brand flex-1" : "flex-1"}>
                    {t.name}
                  </span>
                </MenuItem>
              ))}
            </Menu>

            {/* Status / user menu */}
            <Menu
              align="start"
              placement="up"
              className="block w-full"
              trigger={({ toggle, ref, open }) => (
                <button
                  ref={ref}
                  onClick={toggle}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  aria-label={`Status: ${statusLabel}. Change status`}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-surface-hover border border-transparent hover:border-line transition text-left cursor-pointer"
                >
                  <div className="relative shrink-0">
                    <Avatar name={me.display_name} id={me.id} fileId={me.avatar_file_id} size="sm" />
                    <span className="absolute -bottom-0.5 -right-0.5">
                      <PresenceDot status={myStatus} />
                    </span>
                  </div>
                  <div className="hidden lg:block min-w-0 flex-1">
                    <p className="text-xs font-semibold text-ink truncate leading-tight">{me.display_name}</p>
                    <p className="text-[11px] text-ink-muted truncate mt-0.5">{statusLabel}</p>
                  </div>
                </button>
              )}
            >
              <div className="px-3 py-1.5 mb-1 border-b border-line">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-muted">Set status</p>
              </div>
              {(["online", "away", "dnd"] as const).map((s) => (
                <MenuItem key={s} onClick={() => pickStatus(s)}>
                  <PresenceDot status={s} />
                  <span className={myStatus === s ? "font-semibold" : undefined}>
                    {{ online: "Online", away: "Away", dnd: "Do Not Disturb" }[s]}
                  </span>
                </MenuItem>
              ))}
            </Menu>

            {/* Sign out */}
            <button
              onClick={() => void logout()}
              className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 hover:text-rose-700 dark:hover:text-rose-300 transition cursor-pointer"
            >
              <LogOut className="h-5 w-5 shrink-0" />
              <span className="hidden lg:block text-sm font-medium">Sign out</span>
            </button>
          </div>
        </aside>

        {/* Main content */}
        <main key={view} className="animate-view-in flex-1 min-w-0 flex flex-col pb-16 md:pb-0 app-shell">
          {view === "chats" && <Chats />}
          {view === "directory" && <Directory />}
          {view === "calls" && <CallsHistory />}
          {view === "rooms" && <Rooms />}
          {view === "admin" && me.role === "admin" && <Admin />}
          {view === "settings" && <Settings />}
        </main>

        {/* Mobile bottom nav — 4 primary tabs + More sheet */}
        <nav aria-label="Primary" className="md:hidden fixed bottom-0 inset-x-0 z-40 flex border-t border-line bg-sidebar/95 backdrop-blur-xl shadow-2xl pb-safe-b text-ink">
          {primaryMobile.map(({ id, icon: Icon, label, badge }) => (
            <button
              key={id}
              onClick={() => changeView(id)}
              aria-label={badge ? `${label}, ${badge} unread` : label}
              aria-current={view === id ? "page" : undefined}
              className={`flex-1 flex flex-col items-center gap-1 py-2.5 px-1 text-[10px] font-medium relative transition duration-150 min-h-[56px] justify-center ${
                view === id ? "text-brand" : "text-ink-muted hover:text-ink"
              }`}
            >
              <div className="relative">
                <Icon className="h-6 w-6" />
                {badge != null && badge > 0 && (
                  <span className="absolute -top-1.5 -right-2 rounded-full bg-brand text-white text-[9px] font-bold px-1 min-w-4 text-center leading-4">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </div>
              {label}
            </button>
          ))}
          <button
            onClick={() => setShowMore(true)}
            aria-label="More options"
            aria-expanded={showMore}
            className={`flex-1 flex flex-col items-center gap-1 py-2.5 px-1 text-[10px] font-medium relative transition duration-150 min-h-[56px] justify-center ${
              moreActive ? "text-brand" : "text-ink-muted hover:text-ink"
            }`}
          >
            <div className="relative">
              <MoreHorizontal className="h-6 w-6" />
              {moreActive && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-brand" />}
            </div>
            More
          </button>
        </nav>

        {/* More bottom sheet (mobile) */}
        {showMore && (
          <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="More options">
            <div className="absolute inset-0 bg-black/60" onClick={() => setShowMore(false)} />
            <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-surface border-t border-line shadow-2xl pb-safe-b animate-sheet-in text-ink">
              <div className="flex items-center justify-between px-5 py-4 border-b border-line">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative shrink-0">
                    <Avatar name={me.display_name} id={me.id} fileId={me.avatar_file_id} size="sm" />
                    <span className="absolute -bottom-0.5 -right-0.5">
                      <PresenceDot status={myStatus} />
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate text-ink">{me.display_name}</p>
                    <p className="text-xs text-ink-muted">{statusLabel}</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowMore(false)}
                  className="h-9 w-9 rounded-lg flex items-center justify-center text-ink-muted hover:bg-surface-hover hover:text-ink cursor-pointer"
                  aria-label="Close more options"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-3 space-y-0.5">
                {moreMobile.map(({ id, icon: Icon, label }) => (
                  <button
                    key={id}
                    onClick={() => { changeView(id); setShowMore(false); }}
                    aria-current={view === id ? "page" : undefined}
                    className={`w-full flex items-center gap-3 rounded-xl px-4 py-3.5 text-sm font-medium transition cursor-pointer ${
                      view === id
                        ? "bg-brand/10 text-brand font-semibold"
                        : "text-ink hover:bg-surface-hover"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => void cycleTheme()}
                  className="w-full flex items-center gap-3 rounded-xl px-4 py-3.5 text-sm font-medium text-ink hover:bg-surface-hover transition cursor-pointer"
                >
                  <Palette className="h-5 w-5 text-brand shrink-0" />
                  <div className="flex items-center justify-between flex-1 min-w-0">
                    <span className="truncate">Theme: {currentTheme.name}</span>
                    <span className="text-xs text-ink-muted shrink-0">Tap to cycle</span>
                  </div>
                </button>
                <button
                  onClick={() => void logout()}
                  className="w-full flex items-center gap-3 rounded-xl px-4 py-3.5 text-sm font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                >
                  <LogOut className="h-5 w-5" />
                  Sign out
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
