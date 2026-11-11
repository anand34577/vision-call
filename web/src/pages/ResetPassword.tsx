import { FormEvent, useState } from "react";
import { Loader2, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { Alert, btnPrimary, inputCls } from "../components/ui";

// Reached via the link in a password-reset email: /reset-password?token=...
export default function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await api.confirmPasswordReset(token, password);
      setDone(true);
    } catch (err: any) {
      setError(err?.message ?? "Could not reset password");
    }
    setBusy(false);
  };

  return (
    <div className="ambient-glow relative min-h-full flex items-center justify-center bg-page text-ink p-4 overflow-hidden">
      <div className="relative w-full max-w-sm z-10 animate-view-in">
        <div className="text-center mb-8">
          <div className="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand shadow-lg shadow-brand/40 ring-1 ring-black/10 dark:ring-white/20 mb-4">
            <span className="font-display font-bold text-2xl text-white">V</span>
          </div>
          <h1 className="text-2xl font-bold font-display tracking-tight text-ink">
            Reset your password
          </h1>
          <p className="text-xs text-ink-muted mt-1.5">
            Choose a strong password with at least 8 characters
          </p>
        </div>

        {done ? (
          <div className="rounded-xl border border-line bg-surface p-7 shadow-lg space-y-4 text-center animate-modal-in">
            <CheckCircle2 className="h-10 w-10 text-success mx-auto" />
            <h2 className="text-base font-bold text-ink font-display">Password Changed</h2>
            <p className="text-sm text-ink-muted">
              Your password has been changed. Any previous signed-in sessions were signed out for safety.
            </p>
            <a href="/" className={`${btnPrimary} w-full inline-flex justify-center mt-2`}>
              Go to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={submit} className="rounded-xl border border-line bg-surface p-7 shadow-lg space-y-4 animate-modal-in">
            <div>
              <label htmlFor="reset-new-password" className="block text-xs font-semibold text-ink-secondary mb-1.5">New password</label>
              <div className="relative">
                <input
                  id="reset-new-password"
                  className={`${inputCls} pr-10`}
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  placeholder="Min 8 characters"
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
            </div>
            <div>
              <label htmlFor="reset-confirm-password" className="block text-xs font-semibold text-ink-secondary mb-1.5">Confirm password</label>
              <input
                id="reset-confirm-password"
                className={inputCls}
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                placeholder="Re-enter password"
              />
            </div>
            {error && <Alert variant="error">{error}</Alert>}
            <button className={`${btnPrimary} w-full py-2.5 mt-1`} disabled={busy || !password || !confirm}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Reset password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
