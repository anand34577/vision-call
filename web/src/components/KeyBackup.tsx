import { FormEvent, useEffect, useState } from "react";
import { CloudUpload, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import {
  changeKeyBackupPassword,
  createKeyBackup,
  deleteKeyBackup,
  hasBackupKeyOnDevice,
  isCryptoSubtleAvailable,
  restoreKeyBackup,
} from "../lib/crypto";
import { toast } from "../store/toast";
import { Alert, Modal, btnDestructive, btnGhost, btnPrimary, btnSecondary, inputCls } from "./ui";

type Status = { exists: boolean; updatedAt?: string; onDevice: boolean };

async function loadStatus(): Promise<Status> {
  const res = await api.keyBackup();
  return { exists: res.exists, updatedAt: res.updated_at, onDevice: await hasBackupKeyOnDevice() };
}

function PasswordForm({
  confirm,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  confirm: boolean;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const tooShort = confirm && pw.length > 0 && pw.length < 8;
  const mismatch = confirm && pw2.length > 0 && pw !== pw2;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if ((confirm && (pw.length < 8 || pw !== pw2)) || !pw) return;
    onSubmit(pw);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <input type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Backup password" autoFocus autoComplete={confirm ? "new-password" : "current-password"} />
      {confirm && (
        <input type="password" className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Type it again" autoComplete="new-password" />
      )}
      {tooShort && <p className="text-xs text-warning">Use at least 8 characters.</p>}
      {mismatch && <p className="text-xs text-warning">The passwords don't match.</p>}
      {error && <Alert variant="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={btnGhost} disabled={busy}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={busy || !pw || (confirm && (pw.length < 8 || pw !== pw2))}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Settings section: turn the chat backup on or off, change its password. */
export function KeyBackupSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [mode, setMode] = useState<"create" | "restore" | "change" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = isCryptoSubtleAvailable();

  const refresh = () => void loadStatus().then(setStatus).catch(() => setStatus({ exists: false, onDevice: false }));
  useEffect(refresh, []);

  const run = async (fn: () => Promise<void>, done: string, reload = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast.success(done);
      setMode(null);
      if (reload) window.location.reload();
      else refresh();
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    }
    setBusy(false);
  };

  return (
    <section className="rounded-xl border border-line bg-surface p-5 space-y-4 shadow-sm text-ink">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-sm text-ink flex items-center gap-2">
            <CloudUpload className="h-4 w-4 text-brand" /> Chat backup
          </h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Encrypted messages can only be read on the device they were sent to. A backup, locked with a password only you know, lets you read them on a new
            phone or browser too. It covers messages sent after you turn it on.
          </p>
        </div>
        {status?.exists && (
          <span className="shrink-0 text-xs font-semibold text-success flex items-center gap-1.5 bg-success/10 border border-success/30 px-3 py-1 rounded-full">
            <ShieldCheck className="h-3.5 w-3.5" /> On
          </span>
        )}
      </div>

      {!supported ? (
        <Alert variant="warning">Open Vision Call over HTTPS to use chat backup.</Alert>
      ) : status === null ? (
        <p className="text-xs text-ink-muted flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
        </p>
      ) : !status.exists ? (
        <button onClick={() => setMode("create")} className={btnPrimary}>
          <CloudUpload className="h-4 w-4" /> Turn on backup
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">
            Last updated {status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "recently"}.{" "}
            {status.onDevice ? "This device can read backed-up messages." : "Restore it here to read backed-up messages on this device."}
          </p>
          <div className="flex flex-wrap gap-2">
            {!status.onDevice && (
              <button onClick={() => setMode("restore")} className={btnPrimary}>
                <KeyRound className="h-4 w-4" /> Restore on this device
              </button>
            )}
            {status.onDevice && (
              <button onClick={() => setMode("change")} className={btnSecondary}>
                Change password
              </button>
            )}
            <button onClick={() => setMode("delete")} className={btnGhost}>
              Turn off
            </button>
          </div>
        </div>
      )}

      <Modal open={mode === "create"} onClose={() => !busy && setMode(null)} title="Turn on chat backup">
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">
            Choose a password for your backup. You'll need it on any new device. Nobody, not even your administrator, can recover it if you forget it.
          </p>
          <PasswordForm confirm submitLabel="Turn on" busy={busy} error={error} onCancel={() => setMode(null)} onSubmit={(pw) => void run(() => createKeyBackup(pw), "Chat backup is on.")} />
        </div>
      </Modal>
      <Modal open={mode === "restore"} onClose={() => !busy && setMode(null)} title="Restore chat backup">
        <PasswordForm confirm={false} submitLabel="Restore" busy={busy} error={error} onCancel={() => setMode(null)} onSubmit={(pw) => void run(() => restoreKeyBackup(pw), "Backup restored.", true)} />
      </Modal>
      <Modal open={mode === "change"} onClose={() => !busy && setMode(null)} title="Change backup password">
        <PasswordForm confirm submitLabel="Change password" busy={busy} error={error} onCancel={() => setMode(null)} onSubmit={(pw) => void run(() => changeKeyBackupPassword(pw), "Backup password changed.")} />
      </Modal>
      <Modal open={mode === "delete"} onClose={() => !busy && setMode(null)} title="Turn off chat backup?">
        <div className="space-y-4">
          <p className="text-sm text-ink-secondary">
            The backup is deleted from the server. Devices that already restored it keep reading old messages, but new devices won't be able to.
          </p>
          {error && <Alert variant="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setMode(null)} className={btnGhost} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => void run(deleteKeyBackup, "Chat backup is off.")} className={btnDestructive} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Turn off
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/**
 * Shown once after signing in on a device that doesn't have the backup yet:
 * "you have a backup, restore it to read your older encrypted messages".
 */
export function KeyBackupRestorePrompt({ userID }: { userID: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipKey = `vc.backupPromptSkipped.${userID}`;

  useEffect(() => {
    if (!isCryptoSubtleAvailable()) return;
    try {
      if (localStorage.getItem(skipKey)) return;
    } catch {
      /* ignore */
    }
    void loadStatus()
      .then((s) => setOpen(s.exists && !s.onDevice))
      .catch(() => {});
  }, [skipKey]);

  const skip = () => {
    try {
      localStorage.setItem(skipKey, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  const restore = async (pw: string) => {
    setBusy(true);
    setError(null);
    try {
      await restoreKeyBackup(pw);
      toast.success("Backup restored. Your encrypted messages are readable here now.");
      window.location.reload();
    } catch (err: any) {
      setError(err?.message ?? "Could not restore the backup");
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => !busy && skip()} title="Restore your chat backup?">
      <div className="space-y-3">
        <p className="text-xs text-ink-muted">
          You have a chat backup on this server. Enter your backup password to read your encrypted messages on this device. You can also do this later
          from Settings.
        </p>
        <PasswordForm confirm={false} submitLabel="Restore" busy={busy} error={error} onCancel={skip} onSubmit={(pw) => void restore(pw)} />
      </div>
    </Modal>
  );
}
