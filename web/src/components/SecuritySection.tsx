import { FormEvent, useCallback, useEffect, useState } from "react";
import { Loader2, Laptop, Smartphone, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { Alert, btnGhost, btnPrimary, btnSecondary, inputCls } from "./ui";
import type { SessionInfo } from "../lib/types";

function deviceLabel(ua: string): string {
  if (!ua) return "Unknown device";
  if (/okhttp/i.test(ua)) return "Android app";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function StatusText() {
  const { me, setMe } = useAuth();
  const [text, setText] = useState(me?.status_text ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.setStatusText(text);
      if (me) setMe({ ...me, status_text: r.text });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err: any) {
      setError(err?.message ?? "Could not save status");
    }
  };
  return (
    <form onSubmit={save} className="space-y-2">
      <label htmlFor="status-text" className="block text-xs font-semibold text-ink-secondary">Status message</label>
      <div className="flex gap-2">
        <input id="status-text" className={inputCls} maxLength={140} value={text} onChange={(e) => setText(e.target.value)} placeholder="In a meeting, back at 3…" />
        <button className={btnSecondary}>{saved ? "Saved" : "Save"}</button>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
    </form>
  );
}

function Devices() {
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.sessions().then(setList).catch((e) => setError(e?.message ?? "Could not load devices"));
  }, []);
  useEffect(load, [load]);
  const revoke = async (id: string) => {
    try { await api.revokeSession(id); load(); } catch (e: any) { setError(e?.message ?? "Could not sign out that device"); }
  };
  const revokeOthers = async () => {
    try { await api.revokeOtherSessions(); load(); } catch (e: any) { setError(e?.message ?? "Could not sign out other devices"); }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink-secondary">Signed-in devices</p>
        {list && list.length > 1 && <button onClick={() => void revokeOthers()} className={btnGhost}>Sign out other devices</button>}
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {!list ? <Loader2 className="h-4 w-4 animate-spin text-ink-muted" /> : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
              {/okhttp|Android|iPhone/i.test(s.user_agent) ? <Smartphone className="h-4 w-4 text-ink-muted" /> : <Laptop className="h-4 w-4 text-ink-muted" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{deviceLabel(s.user_agent)}{s.current && <span className="ml-2 text-[10px] font-bold uppercase text-emerald-600">This device</span>}</p>
                <p className="text-xs text-ink-muted truncate">{s.ip || "unknown IP"} · last active {new Date(s.last_seen || s.created_at).toLocaleString()}</p>
              </div>
              {!s.current && <button onClick={() => void revoke(s.id)} className={btnGhost}>Sign out</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TwoFactor() {
  const { me, setMe } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setError(null);
    try { setSetup(await api.totpSetup()); } catch (e: any) { setError(e?.message ?? "Could not start setup"); }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (!setup) return;
    setBusy(true);
    setError(null);
    try {
      await api.totpEnable(setup.secret, code.trim());
      if (me) setMe({ ...me, totp_enabled: true });
      setSetup(null);
      setCode("");
    } catch (err: any) {
      setError(err?.message ?? "Could not enable two-factor");
    }
    setBusy(false);
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.totpDisable(password);
      if (me) setMe({ ...me, totp_enabled: false });
      setShowDisable(false);
      setPassword("");
    } catch (err: any) {
      setError(err?.message ?? "Could not turn off two-factor");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-ink-secondary flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Two-factor authentication</p>
      {error && <Alert variant="error">{error}</Alert>}
      {me?.totp_enabled ? (
        showDisable ? (
          <form onSubmit={disable} className="flex gap-2">
            <input className={inputCls} type="password" placeholder="Confirm your password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <button className={btnPrimary} disabled={busy || !password}>Turn off</button>
          </form>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-muted">On — sign-in asks for a code from your authenticator app.</p>
            <button onClick={() => setShowDisable(true)} className={btnGhost}>Turn off</button>
          </div>
        )
      ) : setup ? (
        <form onSubmit={enable} className="space-y-2">
          <p className="text-xs text-ink-muted">Add this key to an authenticator app (Google Authenticator, Aegis, 1Password, …) as a time-based account, then enter the 6-digit code it shows.</p>
          <code className="block select-all break-all rounded-lg bg-surface-hover px-3 py-2 text-sm tracking-wider">{setup.secret}</code>
          <a href={setup.uri} className="text-xs text-brand hover:underline">Open in authenticator app</a>
          <div className="flex gap-2">
            <input className={inputCls} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
            <button className={btnPrimary} disabled={busy || code.length !== 6}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Turn on</button>
            <button type="button" className={btnGhost} onClick={() => setSetup(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-xs text-ink-muted">Off. Add a second step to sign-in for extra protection.</p>
          <button onClick={() => void begin()} className={btnSecondary}>Set up</button>
        </div>
      )}
    </div>
  );
}

export function SecuritySection() {
  return (
    <section className="rounded-xl border border-line bg-surface p-5 space-y-5 shadow-sm text-ink">
      <h2 className="font-semibold text-sm text-ink">Status &amp; Security</h2>
      <StatusText />
      <Devices />
      <TwoFactor />
    </section>
  );
}
