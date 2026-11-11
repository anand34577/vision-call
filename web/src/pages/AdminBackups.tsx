import { useEffect, useRef, useState } from "react";
import { Archive, Database, Download, History, Loader2, RotateCcw, Upload, AlertTriangle, Plus } from "lucide-react";
import { api } from "../lib/api";
import { fmtBytes } from "../lib/util";
import type { BackupSnapshot } from "../lib/types";
import { toast } from "../store/toast";
import { Alert, EmptyState, Modal, SkeletonList, btnDestructive, btnGhost, btnPrimary, btnSecondary } from "../components/ui";

// After a restore the server restarts itself. Wait for it to answer again,
// then reload: the restored data may not include this session.
async function waitForServer() {
  const deadline = Date.now() + 120_000;
  await new Promise((r) => setTimeout(r, 2500));
  while (Date.now() < deadline) {
    try {
      const res = await fetch("/api/healthz", { cache: "no-store" });
      if (res.ok) return true;
    } catch {
      /* still restarting */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

export default function AdminBackups() {
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [reason, setReason] = useState<string | undefined>();
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "snapshot"; name: string } | { kind: "file"; file: File } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const res = await api.listBackups();
      setSupported(res.supported);
      setReason(res.reason);
      setSnapshots(res.snapshots ?? []);
    } catch (err: any) {
      setError(err?.message ?? "Could not load backups");
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const createNow = async () => {
    setCreating(true);
    try {
      const s = await api.createBackup();
      toast.success(`Backup ${s.name} saved.`);
      await load();
    } catch (err: any) {
      toast.error(err?.message ?? "Could not create a backup");
    }
    setCreating(false);
  };

  const restore = async () => {
    if (!confirm) return;
    setRestoring(true);
    setError(null);
    try {
      let res: { restarting: boolean };
      if (confirm.kind === "snapshot") {
        setPhase("Checking the backup…");
        res = await api.restoreSnapshot(confirm.name);
      } else {
        setPhase("Uploading…");
        res = await api.restoreUpload(confirm.file, (f) => {
          setProgress(f);
          if (f >= 1) setPhase("Checking the backup…");
        });
      }
      setProgress(null);
      if (!res.restarting) {
        setPhase(null);
        setRestoring(false);
        setConfirm(null);
        toast.info("Backup accepted. Restart the server to finish restoring it.");
        return;
      }
      setPhase("Restarting the server with the restored data…");
      const back = await waitForServer();
      if (back) {
        window.location.reload();
      } else {
        setPhase(null);
        setRestoring(false);
        setError("The server hasn't come back yet. If it isn't running under Docker, systemd or the Windows service, start it again yourself.");
      }
    } catch (err: any) {
      setProgress(null);
      setPhase(null);
      setRestoring(false);
      setError(err?.message ?? "Could not restore the backup");
    }
  };

  if (loading) return <SkeletonList rows={3} />;

  if (!supported) {
    return (
      <div className="rounded-xl border border-line bg-surface p-5 shadow-sm">
        <EmptyState icon={<Database className="h-5 w-5" />} title="Backups are handled by your database" hint={reason} />
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {error && !confirm && <Alert variant="error">{error}</Alert>}

      <section className="rounded-xl border border-line bg-surface p-5 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-sm text-ink flex items-center gap-2">
              <Archive className="h-4 w-4 text-brand" /> Full backup
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Everything in one file: accounts, messages, groups, rooms, call history, settings and uploaded files.
            </p>
          </div>
          <a href="/api/admin/backup" className={btnPrimary} download>
            <Download className="h-4 w-4" /> Download
          </a>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line pt-4">
          <div>
            <h2 className="font-semibold text-sm text-ink flex items-center gap-2">
              <Upload className="h-4 w-4 text-brand" /> Restore
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Upload a full backup (.zip) or a database backup (.db). The current data is kept aside on the server first.
            </p>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.db"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setConfirm({ kind: "file", file: f });
              e.target.value = "";
            }}
          />
          <button onClick={() => fileInput.current?.click()} className={btnSecondary}>
            <Upload className="h-4 w-4" /> Choose file
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface shadow-sm overflow-hidden">
        <div className="p-4 border-b border-line flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold text-sm text-ink flex items-center gap-2">
              <History className="h-4 w-4 text-brand" /> Daily backups
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">The database is copied automatically every day. The last 7 copies are kept.</p>
          </div>
          <button onClick={() => void createNow()} disabled={creating} className={btnGhost}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Back up now
          </button>
        </div>
        {snapshots.length === 0 ? (
          <EmptyState icon={<History className="h-5 w-5" />} title="No daily backups yet" hint="The first one is made a couple of minutes after the server starts." />
        ) : (
          <ul className="divide-y divide-line/60">
            {snapshots.map((s, i) => (
              <li key={s.name} className="animate-rise flex items-center gap-3 px-4 py-3" style={{ "--i": i } as React.CSSProperties}>
                <Database className="h-4 w-4 text-ink-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{new Date(s.created_at).toLocaleString()}</p>
                  <p className="text-xs text-ink-muted">
                    {s.name} · {fmtBytes(s.size)}
                  </p>
                </div>
                <a href={`/api/admin/backups/${encodeURIComponent(s.name)}`} className={`${btnGhost} py-1.5 text-xs`} download>
                  <Download className="h-3.5 w-3.5" /> Download
                </a>
                <button onClick={() => setConfirm({ kind: "snapshot", name: s.name })} className={`${btnGhost} py-1.5 text-xs`}>
                  <RotateCcw className="h-3.5 w-3.5" /> Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={!!confirm} onClose={() => !restoring && setConfirm(null)} title="Restore this backup?">
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-3 text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p className="text-xs">
              Everything changes back to{" "}
              <span className="font-semibold">{confirm?.kind === "snapshot" ? confirm.name : confirm?.file.name}</span>. Messages and accounts added since then are
              set aside, not deleted. The server restarts and everyone is signed out.
            </p>
          </div>
          {phase && (
            <div className="space-y-2" aria-live="polite">
              <p className="text-xs text-ink-muted flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {phase}
              </p>
              {progress !== null && (
                <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
                  <div className="h-full bg-brand transition-all duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
            </div>
          )}
          {error && <Alert variant="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirm(null)} className={btnGhost} disabled={restoring}>
              Cancel
            </button>
            <button onClick={() => void restore()} className={btnDestructive} disabled={restoring}>
              {restoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Restore
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
