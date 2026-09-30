import { FormEvent, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { Alert, btnGhost, btnPrimary, inputCls } from "./ui";

// Shown instead of the app while an admin-set password is still in use.
export default function ForcePasswordChange() {
  const logout = useAuth((s) => s.logout);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm !== "" && next !== confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The server signs every device out on success; reload to the login page.
      await api.updateSelf({ current_password: current, new_password: next });
      sessionStorage.setItem("vc.logoutReason", "Your password was changed. Please sign in with the new password.");
      location.reload();
    } catch (err: any) {
      setError(err?.message ?? "Could not change password");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center bg-page text-ink p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-surface p-7 shadow-lg space-y-4">
        <div>
          <h1 className="text-lg font-bold font-display flex items-center gap-2"><Lock className="h-4 w-4 text-brand" /> Choose a new password</h1>
          <p className="text-xs text-ink-muted mt-1">An administrator set your current password. Pick your own before continuing.</p>
        </div>
        <input className={inputCls} type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        <input className={inputCls} type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} />
        <input className={inputCls} type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && <p className="text-xs text-red-500">Passwords don't match</p>}
        {error && <Alert variant="error">{error}</Alert>}
        <button className={`${btnPrimary} w-full`} disabled={busy || !current || next.length < 8 || next !== confirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Change password
        </button>
        <button type="button" className={`${btnGhost} w-full`} onClick={() => void logout()}>Sign out</button>
      </form>
    </div>
  );
}
