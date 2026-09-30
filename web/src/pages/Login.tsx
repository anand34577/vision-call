import { FormEvent, useEffect, useState } from "react";
import { Loader2, Eye, EyeOff, ArrowLeft, User, Lock, ShieldCheck } from "lucide-react";
import { useAuth } from "../store/auth";
import { api } from "../lib/api";
import { requestNotificationPermission } from "../lib/media";
import { Alert, btnPrimary, inputCls } from "../components/ui";

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.requestPasswordReset(email.trim());
      setMessage(res.message);
    } catch (err: any) {
      setMessage(err?.message ?? "Could not submit request");
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="rounded-xl border border-line bg-surface p-7 shadow-lg space-y-5 animate-modal-in">
      <button type="button" onClick={onBack} className="text-xs font-medium text-ink-secondary hover:text-ink flex items-center gap-1.5 transition cursor-pointer">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
      </button>
      <div>
        <h2 className="text-base font-bold font-display text-ink">Reset Password</h2>
        <p className="text-xs text-ink-muted mt-1">Enter your email and we'll send you a recovery link.</p>
      </div>
      <div>
        <label htmlFor="forgot-email" className="block text-xs font-semibold text-ink-secondary mb-1.5">Email address</label>
        <input
          id="forgot-email"
          className={inputCls}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          placeholder="name@example.com"
        />
      </div>
      {message ? (
        <Alert variant="success">{message}</Alert>
      ) : (
        <button className={`${btnPrimary} w-full`} disabled={busy || !email.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Send reset link
        </button>
      )}
    </form>
  );
}

export default function Login() {
  const login = useAuth((s) => s.login);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [resetEnabled, setResetEnabled] = useState(false);
  const [ssoLabel, setSsoLabel] = useState<string | null>(null);
  const [signedOutNotice] = useState(() => {
    const reason = sessionStorage.getItem("vc.logoutReason");
    sessionStorage.removeItem("vc.logoutReason");
    return reason;
  });
  const [ssoError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get("sso-error");
    if (!code) return null;
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    const messages: Record<string, string> = {
      no_linked_account: "No account here is linked to that SSO identity yet. Ask an admin to link your account, or sign in with your username and password.",
      account_disabled: "This account is disabled.",
      access_denied: "SSO sign-in was cancelled.",
    };
    return messages[code] ?? "SSO sign-in failed. Please try again.";
  });

  useEffect(() => {
    api.passwordResetEnabled().then((r) => setResetEnabled(r.enabled)).catch(() => {});
    api.oidcConfig().then((r) => setSsoLabel(r.enabled ? (r.button_label ?? "Sign in with SSO") : null)).catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await login(username.trim(), password, needTotp ? totp.trim() : undefined);
    if (err === "two-factor code required") {
      setNeedTotp(true);
    } else if (err) {
      setError(err);
      if (needTotp) setTotp("");
    } else void requestNotificationPermission();
    setBusy(false);
  };

  return (
    <div className="ambient-glow relative min-h-full flex items-center justify-center bg-page text-ink p-4 overflow-hidden">
      <div className="relative w-full max-w-sm z-10 animate-view-in">
        {signedOutNotice && <div className="mb-4"><Alert variant="info">{signedOutNotice}</Alert></div>}
        {ssoError && <div className="mb-4"><Alert variant="error">{ssoError}</Alert></div>}

        {/* Logo + wordmark */}
        <div className="text-center mb-8">
          <div className="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand shadow-lg shadow-brand/40 ring-1 ring-black/10 dark:ring-white/20 mb-4">
            <span className="font-display font-bold text-2xl text-white">V</span>
            <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-500 ring-2 ring-surface" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-bold font-display tracking-tight text-ink">
            Vision Call
          </h1>
          <p className="text-xs text-ink-muted mt-1.5">
            Encrypted video &amp; messaging — self-hosted
          </p>
        </div>

        {forgotMode ? (
          <ForgotPasswordForm onBack={() => setForgotMode(false)} />
        ) : (
          <form
            onSubmit={submit}
            className="rounded-xl border border-line bg-surface p-7 shadow-lg space-y-4"
          >
            <div>
              <label htmlFor="login-username" className="block text-xs font-semibold text-ink-secondary mb-1.5">
                Username
              </label>
              <div className="relative">
                <User className="absolute left-3 top-2.5 h-4 w-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                <input
                  id="login-username"
                  className={`${inputCls} pl-9`}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  placeholder="Enter your username"
                />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="login-password" className="block text-xs font-semibold text-ink-secondary">
                  Password
                </label>
                {resetEnabled && (
                  <button type="button" onClick={() => setForgotMode(true)} className="text-xs font-medium text-brand hover:underline cursor-pointer">
                    Forgot password?
                  </button>
                )}
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                <input
                  id="login-password"
                  className={`${inputCls} pl-9 pr-10`}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1.5 h-7 w-7 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-hover cursor-pointer"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {capsOn && <p className="text-xs text-amber-500 mt-1.5" role="status">Caps Lock is on</p>}
            </div>
            {needTotp && (
              <div>
                <label htmlFor="login-totp" className="block text-xs font-semibold text-ink-secondary mb-1.5">
                  Authenticator code
                </label>
                <input
                  id="login-totp"
                  className={inputCls}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="6-digit code"
                />
              </div>
            )}
            {error && <Alert variant="error">{error}</Alert>}
            <button className={`${btnPrimary} w-full py-2.5 mt-1`} disabled={busy || !username || !password || (needTotp && totp.length !== 6)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Sign in
            </button>
            <p className="text-[11px] text-center text-ink-muted pt-1 flex items-center justify-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
              Accounts are provisioned by your network administrator
            </p>
            {ssoLabel && (
              <>
                <div className="flex items-center gap-3 text-xs text-ink-muted my-2">
                  <div className="flex-1 h-px bg-line" />
                  <span>or</span>
                  <div className="flex-1 h-px bg-line" />
                </div>
                <a
                  href="/api/oidc/login"
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-line bg-surface hover:bg-surface-hover px-4 py-2.5 text-sm font-semibold text-ink transition"
                >
                  {ssoLabel}
                </a>
              </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
