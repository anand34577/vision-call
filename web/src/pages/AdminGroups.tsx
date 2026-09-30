import { useEffect, useState } from "react";
import { Hash, Loader2, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { Alert, Avatar, EmptyState, Modal, btnDestructive, btnSecondary } from "../components/ui";
import type { Group } from "../lib/types";

// Admin overview of every group and channel, with delete.
export default function AdminGroups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.adminGroups().then(setGroups).catch((e) => setError(e?.message ?? "Could not load groups"));
  useEffect(() => { void load(); }, []);

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.deleteGroup(target.id);
      setTarget(null);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Could not delete the group");
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      {error && <Alert variant="error">{error}</Alert>}
      {groups === null && !error && <p className="text-sm text-ink-muted flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
      {groups?.length === 0 && <EmptyState icon={<Hash className="h-6 w-6" />} title="No groups yet" hint="Groups and channels people create will show up here." />}
      <ul className="space-y-2">
        {groups?.map((g) => (
          <li key={g.id} className="rounded-xl border border-line bg-surface p-3.5 flex items-center gap-3">
            <Avatar name={g.name} id={g.id} fileId={g.avatar_file_id} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                {g.public && <Hash className="h-3.5 w-3.5 text-ink-muted" aria-label="Public channel" />}
                {g.name}
              </p>
              <p className="text-xs text-ink-muted truncate">
                {g.member_count ?? 0} members · created {new Date(g.created_at).toLocaleDateString()}{g.topic ? ` · ${g.topic}` : ""}
              </p>
            </div>
            <button
              onClick={() => setTarget(g)}
              className="h-9 w-9 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 text-ink-muted hover:text-rose-600 flex items-center justify-center"
              title="Delete group"
              aria-label={`Delete ${g.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <Modal open={!!target} onClose={() => (busy ? null : setTarget(null))} title="Delete group?">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">
            This permanently deletes <span className="font-semibold text-zinc-900 dark:text-zinc-200">{target?.name}</span> and all of its messages for everyone. This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button className={btnSecondary} onClick={() => setTarget(null)} disabled={busy}>Cancel</button>
            <button className={btnDestructive} onClick={() => void remove()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
