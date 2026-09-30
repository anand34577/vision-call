import { FormEvent, useEffect, useRef, useState } from "react";
import { KeyBackupSection } from "../components/KeyBackup";
import { SecuritySection } from "../components/SecuritySection";
import { Camera, Volume2, Eye, EyeOff, CheckCircle2, XCircle, Trash2, Loader2, Palette, Check } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { Alert, Avatar, btnGhost, btnPrimary, btnSecondary, inputCls } from "../components/ui";
import {
  THEMES,
  ACCENTS,
  RADII,
  getCurrentPreferences,
  savePreferencesToDb,
  type UserPreferences,
} from "../lib/theme";
import {
  listDevices,
  onDevicesChanged,
  setPreferredDevice,
  type DeviceList,
  requestNotificationPermission,
  getNotificationPermissionStatus,
  createAudioMeter,
  playTestSound,
  stopStream,
} from "../lib/media";

export default function Settings() {
  const { me, setMe } = useAuth();
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [email, setEmail] = useState(me?.email ?? "");
  const [saved, setSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [devices, setDevices] = useState<DeviceList>({ mics: [], cams: [], speakers: [] });

  const [prefs, setPrefs] = useState<UserPreferences>(() => {
    return me?.preferences ?? getCurrentPreferences();
  });
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeSavedBadge, setThemeSavedBadge] = useState(false);

  useEffect(() => {
    if (me?.preferences) {
      setPrefs(me.preferences);
    }
  }, [me?.preferences]);

  const updatePreference = async <K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K],
  ) => {
    const nextPrefs: UserPreferences = {
      ...prefs,
      [key]: value,
    };
    setPrefs(nextPrefs);
    setThemeSaving(true);
    try {
      const persisted = await savePreferencesToDb(nextPrefs);
      if (me) {
        setMe({ ...me, preferences: persisted });
      }
      setThemeSavedBadge(true);
      setTimeout(() => setThemeSavedBadge(false), 2500);
    } finally {
      setThemeSaving(false);
    }
  };

  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoNotice, setSsoNotice] = useState<{ ok: boolean; message: string } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("sso");
    const errCode = params.get("sso-error");
    if (!linked && !errCode) return null;
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    if (linked === "linked") return { ok: true, message: "SSO connected to your account." };
    const messages: Record<string, string> = {
      already_linked: "That SSO identity is already linked to a different account.",
      session_expired: "Your session expired before linking finished — please try again.",
      session_mismatch: "Linking must be started and finished as the same signed-in user.",
    };
    return { ok: false, message: messages[errCode ?? ""] ?? "Could not connect SSO." };
  });

  useEffect(() => {
    api.oidcConfig().then((r) => setSsoEnabled(r.enabled)).catch(() => {});
  }, []);

  const unlinkSso = async () => {
    setSsoBusy(true);
    setSsoNotice(null);
    try {
      await api.oidcUnlink();
      const updated = await api.me();
      setMe(updated);
      setSsoNotice({ ok: true, message: "SSO disconnected." });
    } catch (err: any) {
      setSsoNotice({ ok: false, message: err?.message ?? "Could not disconnect SSO" });
    }
    setSsoBusy(false);
  };

  // Device test state
  const [testingMic, setTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [testingCam, setTestingCam] = useState(false);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [selectedMic, setSelectedMic] = useState(localStorage.getItem("vc.mic") ?? "");
  const [selectedCam, setSelectedCam] = useState(localStorage.getItem("vc.cam") ?? "");
  const [selectedSpeaker, setSelectedSpeaker] = useState(localStorage.getItem("vc.speaker") ?? "");

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Password state
  const [pwdForm, setPwdForm] = useState({ current: "", next: "" });
  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showNextPwd, setShowNextPwd] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);

  const [notifStatus, setNotifStatus] = useState<NotificationPermission>("default");

  useEffect(() => {
    setNotifStatus(getNotificationPermissionStatus());
    void listDevices(true).then(setDevices);
    const off = onDevicesChanged(() => void listDevices(true).then(setDevices));
    return off;
  }, []);

  // Mic test cleanup/init
  useEffect(() => {
    if (!testingMic) {
      setMicLevel(0);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let cleanupMeter: (() => void) | undefined;

    const startTest = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
          video: false,
        };
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stopStream(s);
          return;
        }
        stream = s;
        cleanupMeter = createAudioMeter(stream, (vol) => setMicLevel(vol));
      } catch {
        if (!cancelled) setTestingMic(false);
      }
    };
    void startTest();

    return () => {
      cancelled = true;
      if (cleanupMeter) cleanupMeter();
      stopStream(stream);
    };
  }, [testingMic, selectedMic]);

  // Cam test cleanup/init
  useEffect(() => {
    if (!testingCam) {
      stopStream(camStream);
      setCamStream(null);
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;

    const startTest = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: selectedCam ? { deviceId: { exact: selectedCam } } : true,
        };
        const s = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stopStream(s);
          return;
        }
        stream = s;
        setCamStream(stream);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch {
        if (!cancelled) setTestingCam(false);
      }
    };
    void startTest();

    return () => {
      cancelled = true;
      stopStream(stream);
    };
  }, [testingCam, selectedCam]);

  useEffect(() => {
    if (videoRef.current && camStream) {
      videoRef.current.srcObject = camStream;
    }
  }, [camStream]);

  if (!me) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setProfileError(null);
    try {
      const updated = await api.updateSelf({ display_name: displayName, email });
      if (updated && "id" in updated) setMe(updated as typeof me);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setProfileError(err?.message ?? "Could not save profile");
    }
  };

  const uploadAvatar = async (file: File) => {
    setProfileError(null);
    setAvatarBusy(true);
    try {
      const f = await api.uploadFile(file);
      const updated = await api.updateSelf({ avatar_file_id: f.id });
      if (updated && "id" in updated) setMe(updated as typeof me);
    } catch (err: any) {
      setProfileError(err?.message ?? "Could not update avatar");
    }
    setAvatarBusy(false);
  };

  const removeAvatar = async () => {
    setProfileError(null);
    setAvatarBusy(true);
    try {
      const updated = await api.updateSelf({ avatar_file_id: null });
      if (updated && "id" in updated) setMe(updated as typeof me);
    } catch (err: any) {
      setProfileError(err?.message ?? "Could not remove avatar");
    }
    setAvatarBusy(false);
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwdMsg(null);
    setPwdBusy(true);
    try {
      await api.updateSelf({ current_password: pwdForm.current, new_password: pwdForm.next });
      setPwdMsg({ ok: true, text: "Password changed successfully." });
      setPwdForm({ current: "", next: "" });
    } catch (err: any) {
      setPwdMsg({ ok: false, text: err?.message ?? "Could not change password" });
    }
    setPwdBusy(false);
  };

  const handleRequestNotifs = async () => {
    await requestNotificationPermission();
    setNotifStatus(getNotificationPermissionStatus());
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto p-4 md:p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold font-display tracking-tight text-ink">Settings</h1>
          <p className="text-xs text-ink-muted mt-0.5">Manage your profile, devices, audio/video test bench, and preferences</p>
        </div>

        {/* Profile */}
        <section className="rounded-xl border border-line bg-surface p-5 space-y-5 shadow-sm text-ink">
          <h2 className="font-semibold text-sm text-ink">Profile</h2>
          <div className="flex items-center gap-4">
            <div className="relative">
              <Avatar name={me.display_name} id={me.id} fileId={me.avatar_file_id} size="xl" />
              <button
                onClick={() => fileInput.current?.click()}
                disabled={avatarBusy}
                className="absolute -bottom-1 -right-1 h-9 w-9 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow transition disabled:opacity-50"
                title="Change photo"
                aria-label="Change avatar photo"
              >
                {avatarBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAvatar(f);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="space-y-1 min-w-0 flex-1">
              <p className="font-semibold text-base truncate">{me.display_name}</p>
              <p className="text-xs text-zinc-400">@{me.username} · <span className="capitalize">{me.role}</span></p>
              {me.avatar_file_id != null && (
                <button
                  type="button"
                  onClick={removeAvatar}
                  disabled={avatarBusy}
                  className="text-xs text-rose-500 hover:underline flex items-center gap-1 pt-1"
                >
                  <Trash2 className="h-3 w-3" /> Remove photo
                </button>
              )}
            </div>
          </div>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label htmlFor="settings-display-name" className="block text-xs font-semibold text-zinc-500 mb-1">Display Name</label>
              <input
                id="settings-display-name"
                className={inputCls}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display Name"
              />
            </div>
            <div>
              <label htmlFor="settings-email" className="block text-xs font-semibold text-zinc-500 mb-1">
                Email <span className="font-normal text-zinc-400">(used only for password-reset emails, if your admin has enabled that)</span>
              </label>
              <input
                id="settings-email"
                type="email"
                className={inputCls}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
            <button className={`${btnPrimary} w-full sm:w-auto`} disabled={!displayName.trim()}>
              {saved ? "Saved!" : "Save profile"}
            </button>
          </form>
          {profileError && <Alert variant="error">{profileError}</Alert>}
        </section>

        {/* Connected Accounts (SSO) */}
        {ssoEnabled && (
          <section className="rounded-xl border border-line bg-surface p-5 shadow-sm space-y-3 text-ink">
            <h2 className="font-semibold text-base text-ink">Connected Accounts</h2>
            {ssoNotice && <Alert variant={ssoNotice.ok ? "success" : "error"}>{ssoNotice.message}</Alert>}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">Single sign-on</p>
                <p className="text-xs text-ink-muted">
                  {me?.oidc_linked ? "Your account is linked — you can sign in with SSO." : "Not linked. Sign in still requires your username and password."}
                </p>
              </div>
              {me?.oidc_linked ? (
                <button onClick={() => void unlinkSso()} disabled={ssoBusy} className={btnGhost}>
                  {ssoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Disconnect
                </button>
              ) : (
                <a href="/api/oidc/link" className={btnPrimary}>
                  Connect
                </a>
              )}
            </div>
          </section>
        )}

        {/* Audio & Video Devices with live testing */}
        <section className="rounded-xl border border-line bg-surface p-5 space-y-5 shadow-sm text-ink">
          <div>
            <h2 className="font-semibold text-sm text-ink">Audio & Video Devices</h2>
            <p className="text-xs text-ink-muted mt-0.5">Test and configure your camera, microphone, and speakers</p>
          </div>

          {/* Microphone */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="settings-mic-select" className="block text-xs font-semibold text-zinc-500">Microphone</label>
              <button
                type="button"
                onClick={() => setTestingMic((v) => !v)}
                className={`text-xs px-2.5 py-0.5 rounded-full font-medium transition ${
                  testingMic
                    ? "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300"
                    : "bg-indigo-50 text-blue-400 dark:bg-indigo-950 dark:text-indigo-300 hover:underline"
                }`}
              >
                {testingMic ? "Stop Mic Test" : "Test Microphone"}
              </button>
            </div>
            <select
              id="settings-mic-select"
              className={inputCls}
              value={selectedMic}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedMic(id);
                setPreferredDevice("mic", id || undefined);
              }}
            >
              <option value="">Default Microphone</option>
              {devices.mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Mic (${d.deviceId.slice(0, 5)})`}</option>
              ))}
            </select>
            {testingMic && (
              <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/60 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700">
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>Input Volume</span>
                  <span>{micLevel}%</span>
                </div>
                <div className="h-2 w-full bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500 transition-all duration-75"
                    style={{ width: `${micLevel}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Camera */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="settings-cam-select" className="block text-xs font-semibold text-zinc-500">Camera</label>
              <button
                type="button"
                onClick={() => setTestingCam((v) => !v)}
                className={`text-xs px-2.5 py-0.5 rounded-full font-medium transition ${
                  testingCam
                    ? "bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300"
                    : "bg-indigo-50 text-blue-400 dark:bg-indigo-950 dark:text-indigo-300 hover:underline"
                }`}
              >
                {testingCam ? "Stop Camera Test" : "Test Camera Preview"}
              </button>
            </div>
            <select
              id="settings-cam-select"
              className={inputCls}
              value={selectedCam}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedCam(id);
                setPreferredDevice("cam", id || undefined);
              }}
            >
              <option value="">Default Camera</option>
              {devices.cams.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera (${d.deviceId.slice(0, 5)})`}</option>
              ))}
            </select>
            {testingCam && (
              <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-black border border-zinc-200 dark:border-zinc-700">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover -scale-x-100"
                />
                <span className="absolute bottom-2 left-2 bg-black/60 text-white text-[11px] px-2 py-0.5 rounded backdrop-blur">
                  Live Camera Preview
                </span>
              </div>
            )}
          </div>

          {/* Speaker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="settings-speaker-select" className="block text-xs font-semibold text-zinc-500">Speaker</label>
              <button
                type="button"
                onClick={playTestSound}
                className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-50 text-blue-400 dark:bg-indigo-950 dark:text-indigo-300 font-medium hover:underline flex items-center gap-1"
              >
                <Volume2 className="h-3 w-3" /> Play Test Sound
              </button>
            </div>
            <select
              id="settings-speaker-select"
              className={inputCls}
              value={selectedSpeaker}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedSpeaker(id);
                setPreferredDevice("speaker", id || undefined);
              }}
            >
              <option value="">Default Speaker</option>
              {devices.speakers.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker (${d.deviceId.slice(0, 5)})`}</option>
              ))}
            </select>
          </div>
        </section>

        {/* Appearance & Themes */}
        <section className="rounded-xl border border-line bg-surface p-5 space-y-6 shadow-sm text-ink">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-brand" />
                <h2 className="font-semibold text-sm text-ink">Appearance & Themes</h2>
              </div>
              <p className="text-xs text-ink-muted mt-0.5">
                Customize your color palette, vibrancy accent, and interface corner radius
              </p>
            </div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              {themeSaving && (
                <span className="text-[11px] font-medium text-ink-muted flex items-center gap-1.5 bg-surface-hover px-2.5 py-1 rounded-full border border-line">
                  <Loader2 className="h-3 w-3 animate-spin text-brand" /> Saving to DB…
                </span>
              )}
              {themeSavedBadge && !themeSaving && (
                <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-800/60 animate-modal-in">
                  <CheckCircle2 className="h-3 w-3" /> Saved to DB
                </span>
              )}
            </div>
          </div>

          {/* Theme Palette Grid */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider">
                Theme Palette ({THEMES.length} styles)
              </label>
              <span className="text-[11px] text-ink-muted capitalize">
                Active: {THEMES.find((t) => t.id === prefs.theme)?.name ?? prefs.theme}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {THEMES.map((t) => {
                const isActive = prefs.theme === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => updatePreference("theme", t.id)}
                    className={`group relative text-left rounded-xl border p-3 transition-all duration-150 flex flex-col justify-between cursor-pointer ${
                      isActive
                        ? "border-brand ring-2 ring-brand/30 bg-surface shadow-sm"
                        : "border-line bg-surface-hover hover:border-line-strong"
                    }`}
                  >
                    {/* Miniature window mockup preview */}
                    <div
                      className="w-full h-16 rounded-lg p-1.5 mb-2.5 flex flex-col justify-between border border-black/10 dark:border-white/10 shadow-inner overflow-hidden"
                      style={{ backgroundColor: t.bgHex }}
                    >
                      <div className="flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.accentHex }} />
                        <span className="h-1 w-6 rounded-full bg-white/20" />
                        <span className="h-1 w-4 rounded-full bg-white/10" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div
                          className="h-7 w-5 rounded shrink-0 border border-white/10"
                          style={{ backgroundColor: t.cardHex }}
                        />
                        <div className="flex-1 space-y-1">
                          <div
                            className="h-3 w-full rounded border border-white/10 flex items-center px-1"
                            style={{ backgroundColor: t.cardHex }}
                          >
                            <span className="h-1 w-3 rounded-full" style={{ backgroundColor: t.accentHex }} />
                          </div>
                          <div
                            className="h-3 w-3/4 rounded border border-white/10"
                            style={{ backgroundColor: t.cardHex }}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-start justify-between gap-1 w-full">
                      <div className="min-w-0 flex-1">
                        <p className={`text-xs font-semibold truncate ${isActive ? "text-brand" : "text-ink"}`}>
                          {t.name}
                        </p>
                        <p className="text-[10px] text-ink-muted line-clamp-1 mt-0.5">
                          {t.description}
                        </p>
                      </div>
                      {isActive && (
                        <span className="h-4 w-4 rounded-full bg-brand text-white flex items-center justify-center shrink-0 mt-0.5">
                          <Check className="h-2.5 w-2.5" />
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Accent Color Selection */}
          <div className="space-y-2.5 pt-3 border-t border-line">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider">
                Accent Vibrancy
              </label>
              <span className="text-[11px] text-ink-muted capitalize">
                {ACCENTS.find((a) => a.id === prefs.accent_color)?.name ?? prefs.accent_color}
              </span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
              {ACCENTS.map((a) => {
                const isActive = prefs.accent_color === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => updatePreference("accent_color", a.id)}
                    className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border transition-all cursor-pointer ${
                      isActive
                        ? "border-brand bg-brand-subtle ring-2 ring-brand/30"
                        : "border-line bg-surface hover:bg-surface-hover hover:border-line-strong"
                    }`}
                  >
                    <span
                      className="h-6 w-6 rounded-full flex items-center justify-center shadow-xs text-white"
                      style={{ backgroundColor: a.hex }}
                    >
                      {isActive && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                    </span>
                    <span className="text-[11px] font-medium text-ink truncate w-full text-center">
                      {a.name.split(" ")[0]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Interface Corner Radius */}
          <div className="space-y-2.5 pt-3 border-t border-line">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider">
                Corner Radius & Geometry
              </label>
              <span className="text-[11px] text-ink-muted capitalize">
                {RADII.find((r) => r.id === prefs.radius)?.name ?? prefs.radius}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {RADII.map((r) => {
                const isActive = prefs.radius === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => updatePreference("radius", r.id)}
                    className={`flex flex-col items-center justify-center p-3 text-center border transition-all cursor-pointer ${
                      r.id === "compact"
                        ? "rounded-md"
                        : r.id === "pill"
                        ? "rounded-2xl"
                        : "rounded-xl"
                    } ${
                      isActive
                        ? "border-brand bg-brand-subtle ring-2 ring-brand/30"
                        : "border-line bg-surface hover:bg-surface-hover hover:border-line-strong"
                    }`}
                  >
                    <span className={`text-xs font-semibold ${isActive ? "text-brand" : "text-ink"}`}>{r.name}</span>
                    <span className="text-[10px] text-ink-muted mt-0.5">{r.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="rounded-xl border border-line bg-surface p-5 space-y-4 shadow-sm text-ink">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-sm text-ink">Browser Notifications</h2>
              <p className="text-xs text-ink-muted mt-0.5">Receive alerts for incoming calls and new messages</p>
            </div>
            <div className="flex items-center gap-1.5">
              {notifStatus === "granted" && (
                <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 px-3 py-1 rounded-full">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Enabled
                </span>
              )}
              {notifStatus === "denied" && (
                <span title={window.isSecureContext ? "Blocked in browser settings" : "Needs HTTPS"} className="text-xs font-semibold text-rose-600 dark:text-rose-400 flex items-center gap-1.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/60 px-3 py-1 rounded-full">
                  <XCircle className="h-3.5 w-3.5" /> Blocked
                </span>
              )}
              {notifStatus === "default" && (
                <button onClick={handleRequestNotifs} className={btnPrimary}>
                  Enable
                </button>
              )}
            </div>
          </div>
          {notifStatus === "denied" && !window.isSecureContext && (
            <Alert variant="warning">
              Browsers only allow notifications over HTTPS. Open Vision Call with its https:// address (port 8443) to turn them on. Until then, new messages show as pop-ups inside the app.
            </Alert>
          )}
          {notifStatus === "denied" && window.isSecureContext && (
            <Alert variant="warning">
              Notifications are blocked for this site. Click the lock icon next to the address bar, allow notifications, then reload the page.
            </Alert>
          )}
        </section>

        <SecuritySection />
        <KeyBackupSection />

        {/* Change Password */}
        <section className="rounded-xl border border-line bg-surface p-5 space-y-5 shadow-sm text-ink">
          <h2 className="font-semibold text-sm text-ink">Change Password</h2>
          <form onSubmit={changePassword} className="space-y-3">
            <div className="relative">
              <label htmlFor="settings-current-pwd" className="sr-only">Current password</label>
              <input
                id="settings-current-pwd"
                className={inputCls}
                type={showCurrentPwd ? "text" : "password"}
                placeholder="Current password"
                value={pwdForm.current}
                onChange={(e) => setPwdForm({ ...pwdForm, current: e.target.value })}
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowCurrentPwd(!showCurrentPwd)}
                aria-label={showCurrentPwd ? "Hide password" : "Show password"}
                className="absolute right-3 top-2.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                {showCurrentPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="relative">
              <label htmlFor="settings-next-pwd" className="sr-only">New password</label>
              <input
                id="settings-next-pwd"
                className={inputCls}
                type={showNextPwd ? "text" : "password"}
                placeholder="New password (min 8 characters)"
                value={pwdForm.next}
                onChange={(e) => setPwdForm({ ...pwdForm, next: e.target.value })}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowNextPwd(!showNextPwd)}
                aria-label={showNextPwd ? "Hide password" : "Show password"}
                className="absolute right-3 top-2.5 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                {showNextPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {pwdMsg && <Alert variant={pwdMsg.ok ? "success" : "error"}>{pwdMsg.text}</Alert>}
            <button
              className={`${btnPrimary} w-full`}
              disabled={pwdBusy || !pwdForm.current || pwdForm.next.length < 8}
            >
              {pwdBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Update Password
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

