import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Hash, HardDrive, PhoneCall, RefreshCw, UserPlus, Users, Activity, Search, Eye, EyeOff, Trash2, AlertTriangle, Loader2, ScrollText, Settings as SettingsIcon, Lock, RotateCcw, PhoneCall as CallIcon, FolderCog, Mail, KeyRound, ShieldCheck, Network, Server, Pencil, Ban, UserCheck, LogOut, Copy, Wand2, Archive } from "lucide-react";
import { api } from "../lib/api";
import { useDirectory } from "../store/directory";
import { useAuth } from "../store/auth";
import AdminGroups from "./AdminGroups";
import { Alert, Avatar, Modal, PresenceDot, Switch, Tabs, SkeletonList, EmptyState, btnDestructive, btnGhost, btnPrimary, btnSecondary, inputCls } from "../components/ui";
import { fmtBytes, presenceLabel } from "../lib/util";
import type { AdminStats, AuditEntry, SettingView, User } from "../lib/types";
import { toast } from "../store/toast";
import AdminBackups from "./AdminBackups";

type AdminTab = "users" | "groups" | "audit" | "settings" | "backups";

// Admin's active tab lives at "#admin/<tab>" (bare "#admin" = users) so a
// reload lands back on the same tab instead of always resetting to Users.
function parseAdminTab(): AdminTab {
  const hash = window.location.hash.replace("#", "");
  const sub = hash.startsWith("admin/") ? hash.slice("admin/".length) : "";
  return sub === "groups" || sub === "audit" || sub === "settings" || sub === "backups" ? sub : "users";
}

const GROUP_ICON: Record<string, typeof Users> = {
  "Calling & Media": CallIcon,
  "Files & Storage": FolderCog,
  "Email & Password Reset": Mail,
  "Single Sign-On (SSO)": KeyRound,
  "Security & Sessions": ShieldCheck,
  "Network & TLS": Network,
  "Server & Logging": Server,
};

const SOURCE_LABEL: Record<SettingView["source"], string> = {
  env: "Environment / .env",
  db: "Set here",
  default: "Default",
};

function SettingRow({ s, onSaved }: { s: SettingView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(s.kind === "secret" ? "" : s.value);
    setError(null);
    setEditing(true);
  };

  const save = async (value = draft) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateSetting(s.key, value);
      setEditing(false);
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? "Could not save");
    }
    setBusy(false);
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.resetSetting(s.key);
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? "Could not reset");
    }
    setBusy(false);
  };

  const lockTitle = s.source === "env" ? "Set by an environment variable or .env file — edit that, then restart" : "Fixed at server start — change via environment/.env and restart";

  // Boolean settings are a straight on/off switch with no separate edit
  // step — flipping it saves immediately, same as any other toggle in the app.
  if (s.kind === "bool") {
    const on = s.value === "true";
    return (
      <div className="px-4 py-3 border-b border-line/60 last:border-0 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium">{s.label}</p>
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${s.source === "db" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : s.source === "env" ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 text-zinc-400" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 text-zinc-500"}`}>
              {SOURCE_LABEL[s.source]}
            </span>
            {!s.editable && (
              <span title={lockTitle} className="text-zinc-400">
                <Lock className="h-3 w-3" />
              </span>
            )}
          </div>
          {s.description && <p className="text-xs text-zinc-400 mt-0.5">{s.description}</p>}
          {error && <p className="text-xs text-rose-500 mt-1">{error}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
          <Switch checked={on} disabled={!s.editable || busy} onChange={(next) => void save(String(next))} label={s.label} />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-line/60 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium">{s.label}</p>
            <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${s.source === "db" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : s.source === "env" ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 text-zinc-400" : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 text-zinc-500"}`}>
              {SOURCE_LABEL[s.source]}
            </span>
            {!s.editable && (
              <span title={lockTitle} className="text-zinc-400">
                <Lock className="h-3 w-3" />
              </span>
            )}
          </div>
          {s.description && <p className="text-xs text-zinc-400 mt-0.5">{s.description}</p>}
          {!editing && (
            <p className="text-sm font-mono mt-1 text-zinc-600 dark:text-zinc-300 break-all">
              {s.value === "" ? <span className="italic text-zinc-400">empty</span> : s.value}
            </p>
          )}
          {editing && (
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <input
                autoFocus
                type={s.kind === "secret" ? "password" : s.kind === "int" ? "number" : "text"}
                className={`${inputCls} flex-1 min-w-[12rem] py-1 text-xs`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={s.kind === "secret" ? "New value (leave blank to cancel)" : undefined}
                onKeyDown={(e) => e.key === "Enter" && void save()}
              />
              <button onClick={() => void save()} disabled={busy} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1.5 disabled:opacity-50">
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
              </button>
              <button onClick={() => setEditing(false)} disabled={busy} className="text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
                Cancel
              </button>
            </div>
          )}
          {error && <p className="text-xs text-rose-500 mt-1">{error}</p>}
        </div>
        {s.editable && !editing && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={startEdit} className="text-xs px-2.5 py-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 font-medium">
              Edit
            </button>
            {s.source === "db" && (
              <button onClick={() => void reset()} disabled={busy} title="Reset to default" aria-label="Reset to default" className="h-7 w-7 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-400 disabled:opacity-50">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerSettings() {
  const [settings, setSettings] = useState<SettingView[]>([]);
  const [loading, setLoading] = useState(true);

  // Only the very first load (and an explicit Refresh click) shows the
  // "Loading…" placeholder — reloading after saving one setting must not
  // collapse the whole list down to a spinner and back, which is what was
  // causing the page to visibly jump every time a setting was changed.
  const load = (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    api.listSettings().then(setSettings).catch(() => {}).finally(() => setLoading(false));
  };
  const reloadAfterEdit = () => load(false);

  useEffect(() => load(true), []);

  const groups = useMemo(() => {
    const byGroup = new Map<string, SettingView[]>();
    for (const s of settings) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, []);
      byGroup.get(s.group)!.push(s);
    }
    return byGroup;
  }, [settings]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-4 w-4 text-zinc-400" />
          <h2 className="font-semibold text-base">Server Settings</h2>
        </div>
        <button onClick={() => load(true)} className={btnGhost}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>
      <p className="text-xs text-zinc-400">
        Priority: environment variable / Docker <code>environment:</code> &gt; <code>.env</code> file &gt; set here &gt; default.
        Settings marked <Lock className="h-3 w-3 inline" /> are pinned by the environment/.env and can only be changed there, then a restart.
      </p>
      {loading ? (
        <p className="p-6 text-center text-xs text-zinc-400 flex items-center justify-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        Array.from(groups.entries()).map(([group, items]) => {
          const GroupIcon = GROUP_ICON[group] ?? SettingsIcon;
          return (
            <section key={group} className="rounded-xl border border-line bg-surface overflow-hidden shadow-sm">
              <div className="px-4 py-2.5 border-b border-line bg-surface-hover/40 flex items-center gap-2">
                <GroupIcon className="h-4 w-4 text-brand" />
                <h3 className="text-sm font-semibold">{group}</h3>
              </div>
              {items.map((s) => (
                <SettingRow key={s.key} s={s} onSaved={reloadAfterEdit} />
              ))}
            </section>
          );
        })
      )}
    </div>
  );
}

function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const [query, setQuery] = useState("");

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = async (before?: number) => {
    const page = await api.auditLog(before);
    if (!mounted.current) return;
    setEntries((prev) => (before ? [...prev, ...page] : page));
    if (page.length < 100) setDone(true);
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => { if (mounted.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = async () => {
    if (entries.length === 0) return;
    setLoadingMore(true);
    await load(entries[entries.length - 1].id).finally(() => { if (mounted.current) setLoadingMore(false); });
  };

  const filtered = query.trim()
    ? entries.filter((e) =>
        `${e.actor_name} ${e.action} ${e.target_type} ${e.detail} ${e.ip}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : entries;

  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden shadow-sm">
      <div className="p-4 border-b border-line flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-ink-muted" />
          <h2 className="font-semibold text-base">Audit Log</h2>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter actions, actors, IPs…"
          aria-label="Filter audit log"
          className="sm:ml-auto rounded-lg border border-line bg-surface text-ink px-3 py-1.5 text-xs w-full sm:w-64 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted border-b border-line bg-surface-hover/40">
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Actor</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Target</th>
              <th className="px-4 py-2.5 font-medium">Detail</th>
              <th className="px-4 py-2.5 font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id} className="border-b border-line/60 last:border-0 hover:bg-surface-hover/50 transition">
                <td className="px-4 py-2 text-xs text-ink-muted whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-xs">{e.actor_name}</td>
                <td className="px-4 py-2 text-xs font-mono">{e.action}</td>
                <td className="px-4 py-2 text-xs text-ink-muted">{e.target_type}{e.target_id ? ` #${e.target_id}` : ""}</td>
                <td className="px-4 py-2 text-xs text-ink-muted max-w-xs truncate" title={e.detail}>{e.detail}</td>
                <td className="px-4 py-2 text-xs text-ink-muted">{e.ip}</td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-ink-muted text-xs">{query ? "No entries match this filter." : "No audit entries yet."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!done && entries.length > 0 && (
        <div className="p-3 flex justify-center border-t border-line">
          <button onClick={() => void loadMore()} disabled={loadingMore} className={btnGhost}>
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 flex items-center gap-4 shadow-2xs hover:shadow-md hover:border-brand/40 transition-all duration-150">
      <div className="h-11 w-11 rounded-xl bg-brand/15 text-brand flex items-center justify-center shrink-0 shadow-2xs">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold tracking-tight text-ink leading-tight">{value}</p>
        <p className="text-xs text-ink-muted mt-0.5 font-medium">{label}</p>
      </div>
    </div>
  );
}

type UserFilter = "all" | "admin" | "user" | "suspended" | "deleted";

const FILTERS: { key: UserFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "admin", label: "Admins" },
  { key: "user", label: "Users" },
  { key: "suspended", label: "Suspended" },
  { key: "deleted", label: "Deleted" },
];

function matchesFilter(u: User, f: UserFilter): boolean {
  switch (f) {
    case "all":
      return !u.deleted;
    case "admin":
      return !u.deleted && u.role === "admin";
    case "user":
      return !u.deleted && u.role === "user";
    case "suspended":
      return !u.deleted && u.disabled;
    case "deleted":
      return u.deleted;
  }
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={id} className="block text-xs font-semibold text-ink-muted">
          {label}
        </label>
        <button
          type="button"
          onClick={() => {
            onChange(generatePassword());
            setShow(true);
          }}
          className="text-xs font-medium text-brand hover:text-brand-hover inline-flex items-center gap-1 cursor-pointer"
        >
          <Wand2 className="h-3 w-3" /> Generate
        </button>
      </div>
      <div className="relative">
        <input
          id={id}
          className={`${inputCls} pr-20`}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          placeholder={placeholder}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {value && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(value).then(() => toast.success("Password copied."));
              }}
              aria-label="Copy password"
              className="h-7 w-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-hover cursor-pointer"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label={show ? "Hide password" : "Show password"}
            className="h-7 w-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-hover cursor-pointer"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ u }: { u: User }) {
  if (u.deleted) {
    return <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-zinc-500/15 text-ink-muted">Deleted</span>;
  }
  if (u.disabled) {
    return <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-amber-500/15 text-amber-500">Suspended</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-muted">
      <PresenceDot status={u.status} /> {presenceLabel(u.status)}
    </span>
  );
}

function RowAction({
  label,
  onClick,
  children,
  tone = "default",
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "danger" | "warn" | "good";
}) {
  const tones = {
    default: "text-ink-secondary hover:text-ink hover:bg-surface-hover",
    danger: "text-rose-500 hover:bg-rose-500/10",
    warn: "text-amber-500 hover:bg-amber-500/10",
    good: "text-emerald-500 hover:bg-emerald-500/10",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`h-9 w-9 rounded-lg flex items-center justify-center transition active:scale-95 cursor-pointer ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export default function Admin() {
  const me = useAuth((s) => s.me)!;
  const { users, fetchUsers, loaded: usersLoaded, error: usersError } = useDirectory();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [deleteMode, setDeleteMode] = useState<"remove" | "erase">("remove");
  const [eraseConfirm, setEraseConfirm] = useState("");
  const [userToSuspend, setUserToSuspend] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinkingSso, setUnlinkingSso] = useState(false);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UserFilter>("all");

  const [editForm, setEditForm] = useState({ display_name: "", role: "user", password: "", email: "" });
  const [createForm, setCreateForm] = useState({ username: "", display_name: "", password: "", role: "user", email: "" });

  const [error, setError] = useState<string | null>(null);
  const [tab, setTabState] = useState<AdminTab>(parseAdminTab);
  // Kept in the URL hash (admin/audit, admin/settings) so a reload - or a
  // bookmark/shared link - lands back on the same tab instead of always
  // resetting to Users.
  const setTab = (t: AdminTab) => {
    setTabState(t);
    window.location.hash = t === "users" ? "admin" : `admin/${t}`;
  };
  useEffect(() => {
    const onHashChange = () => setTabState(parseAdminTab());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const loadStats = async () => {
    try {
      setStats(await api.adminStats());
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void fetchUsers();
    void loadStats();
    const t = setInterval(() => void loadStats(), 10000);
    return () => clearInterval(t);
  }, [fetchUsers]);

  const counts = useMemo(() => {
    const c = { all: 0, admin: 0, user: 0, suspended: 0, deleted: 0 } as Record<UserFilter, number>;
    for (const u of users) for (const f of FILTERS) if (matchesFilter(u, f.key)) c[f.key]++;
    return c;
  }, [users]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(
      (u) =>
        matchesFilter(u, filter) &&
        (!q || u.display_name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q)),
    );
  }, [users, search, filter]);

  const refresh = () => {
    void fetchUsers();
    void loadStats();
  };

  // Runs an admin action with shared busy/error/toast handling.
  const run = async (action: () => Promise<unknown>, success: string, done?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      toast.success(success);
      done?.();
      refresh();
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    }
    setBusy(false);
  };

  const openEdit = (u: User) => {
    setEditing(u);
    setError(null);
    setEditForm({ display_name: u.display_name, role: u.role, password: "", email: u.email ?? "" });
  };

  const openDelete = (u: User) => {
    setError(null);
    setEraseConfirm("");
    setDeleteMode(u.deleted ? "erase" : "remove");
    setUserToDelete(u);
  };

  const unlinkUserSso = async () => {
    if (!editing) return;
    setUnlinkingSso(true);
    setError(null);
    try {
      await api.adminOidcUnlink(editing.id);
      setEditing({ ...editing, oidc_linked: false });
      toast.success("Single sign-on unlinked.");
      void fetchUsers();
    } catch (err: any) {
      setError(err?.message ?? "Could not unlink SSO");
    }
    setUnlinkingSso(false);
  };

  const saveEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const passwordChanged = !!editForm.password;
    void run(
      () =>
        api.updateUser(editing.id, {
          display_name: editForm.display_name,
          role: editForm.role,
          email: editForm.email,
          ...(passwordChanged ? { password: editForm.password } : {}),
        }),
      passwordChanged
        ? `Saved. ${editing.display_name} was signed out and must use the new password.`
        : `Saved changes to ${editing.display_name}.`,
      () => setEditing(null),
    );
  };

  const saveCreate = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.createUser(createForm), `Created ${createForm.display_name || createForm.username}.`, () => {
      setCreating(false);
      setCreateForm({ username: "", display_name: "", password: "", role: "user", email: "" });
    });
  };

  const confirmSuspend = () => {
    if (!userToSuspend) return;
    const u = userToSuspend;
    void run(
      () => api.updateUser(u.id, { disabled: !u.disabled }),
      u.disabled ? `${u.display_name} can sign in again.` : `${u.display_name} is suspended and was signed out.`,
      () => setUserToSuspend(null),
    );
  };

  const signOutEverywhere = (u: User) => {
    void run(() => api.signOutUser(u.id), `${u.display_name} was signed out of every device.`);
  };

  const confirmDelete = () => {
    if (!userToDelete) return;
    const u = userToDelete;
    const erase = deleteMode === "erase";
    void run(
      () => api.deleteUser(u.id, erase),
      erase ? `${u.display_name} and all their data were erased.` : `${u.display_name} was removed.`,
      () => setUserToDelete(null),
    );
  };

  const modalOpen = !!editing || creating || !!userToDelete || !!userToSuspend;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold font-display tracking-tight">Admin Panel</h1>
            <p className="text-xs text-ink-muted">Manage people, watch usage and review activity</p>
          </div>
          <button onClick={refresh} className={btnGhost}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        {error && !modalOpen && <Alert variant="error">{error}</Alert>}

        <Tabs
          className="border-b border-line pb-1"
          active={tab}
          onChange={(id) => setTab(id as AdminTab)}
          tabs={[
            { key: "users", label: "Users", icon: <Users className="h-4 w-4" /> },
            { key: "groups", label: "Groups", icon: <Hash className="h-4 w-4" /> },
            { key: "audit", label: "Audit Log", icon: <ScrollText className="h-4 w-4" /> },
            { key: "settings", label: "Server Settings", icon: <SettingsIcon className="h-4 w-4" /> },
            { key: "backups", label: "Backups", icon: <Archive className="h-4 w-4" /> },
          ]}
        />

        {tab === "users" && stats && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { icon: Users, label: "Accounts", value: String(stats.users) },
              { icon: Activity, label: "Online now", value: String(stats.online) },
              { icon: PhoneCall, label: "Active calls", value: String(stats.active_calls) },
              { icon: HardDrive, label: `Storage (${stats.db_driver})`, value: fmtBytes(stats.storage.total_bytes) },
            ].map((s, i) => (
              <div key={s.label} className="animate-rise" style={{ "--i": i } as React.CSSProperties}>
                <StatCard icon={s.icon} label={s.label} value={s.value} />
              </div>
            ))}
          </div>
        )}

        {tab === "users" && (
          <div className="rounded-xl border border-line bg-surface overflow-hidden shadow-sm animate-fade-in">
            <div className="p-4 border-b border-line flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter users">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    role="tab"
                    aria-selected={filter === f.key}
                    onClick={() => setFilter(f.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 cursor-pointer ${
                      filter === f.key ? "bg-brand text-white shadow-sm" : "text-ink-secondary hover:bg-surface-hover"
                    }`}
                  >
                    {f.label}
                    <span className={`ml-1.5 tabular-nums ${filter === f.key ? "text-white/80" : "text-ink-muted"}`}>{counts[f.key]}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1 lg:w-56">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-muted" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, username or email"
                    className={`${inputCls} pl-8 py-1.5 text-xs`}
                  />
                </div>
                <button
                  onClick={() => {
                    setCreating(true);
                    setError(null);
                  }}
                  className={btnPrimary}
                >
                  <UserPlus className="h-4 w-4" /> <span className="hidden sm:inline">New user</span>
                </button>
              </div>
            </div>

            {!usersLoaded && !usersError && <SkeletonList rows={5} />}
            {usersError && users.length === 0 && (
              <EmptyState icon={<AlertTriangle className="h-5 w-5" />} title="Couldn't load users" hint={usersError} />
            )}
            {usersLoaded && filteredUsers.length === 0 && (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title={filter === "deleted" ? "No deleted accounts" : filter === "suspended" ? "Nobody is suspended" : "No matching users"}
                hint={search ? "Try a different search." : undefined}
              />
            )}
            {usersLoaded && filteredUsers.length > 0 && (
              <ul className="divide-y divide-line/60">
                {filteredUsers.map((u, i) => {
                  const isMe = u.id === me.id;
                  return (
                    <li
                      key={u.id}
                      className="animate-rise flex items-center gap-3 px-4 py-3 hover:bg-surface-hover/50 transition-colors"
                      style={{ "--i": i } as React.CSSProperties}
                    >
                      <div className={u.deleted || u.disabled ? "opacity-60" : undefined}>
                        <Avatar name={u.display_name} id={u.id} fileId={u.avatar_file_id} size="sm" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-ink truncate flex items-center gap-2">
                          <span className="truncate">{u.display_name}</span>
                          {isMe && <span className="text-[10px] font-semibold text-ink-muted">(you)</span>}
                          {u.role === "admin" && !u.deleted && (
                            <span className="text-[10px] uppercase font-bold rounded px-1.5 py-0.5 bg-brand/15 text-brand">admin</span>
                          )}
                          {u.oidc_linked && <span className="text-[10px] uppercase font-bold rounded px-1.5 py-0.5 bg-sky-500/15 text-sky-500">SSO</span>}
                        </p>
                        <p className="text-xs text-ink-muted truncate">
                          @{u.username}
                          {u.email ? ` · ${u.email}` : ""}
                        </p>
                      </div>
                      <div className="hidden sm:block w-28 shrink-0">
                        <StatusPill u={u} />
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {u.deleted ? (
                          <RowAction label="Erase permanently" tone="danger" onClick={() => openDelete(u)}>
                            <Trash2 className="h-4 w-4" />
                          </RowAction>
                        ) : (
                          <>
                            <RowAction label="Edit" onClick={() => openEdit(u)}>
                              <Pencil className="h-4 w-4" />
                            </RowAction>
                            {!isMe && (
                              <>
                                {u.disabled ? (
                                  <RowAction label="Reactivate" tone="good" onClick={() => { setError(null); setUserToSuspend(u); }}>
                                    <UserCheck className="h-4 w-4" />
                                  </RowAction>
                                ) : (
                                  <RowAction label="Suspend" tone="warn" onClick={() => { setError(null); setUserToSuspend(u); }}>
                                    <Ban className="h-4 w-4" />
                                  </RowAction>
                                )}
                                <RowAction label="Delete" tone="danger" onClick={() => openDelete(u)}>
                                  <Trash2 className="h-4 w-4" />
                                </RowAction>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {tab === "groups" && <AdminGroups />}
        {tab === "audit" && <AuditLog />}

        {tab === "settings" && <ServerSettings />}

        {tab === "backups" && <AdminBackups />}

        {/* Edit */}
        <Modal open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.display_name ?? ""}`}>
          <form onSubmit={saveEdit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-user-name" className="block text-xs font-semibold text-ink-muted mb-1">Display name</label>
                <input id="edit-user-name" className={inputCls} value={editForm.display_name} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} />
              </div>
              <div>
                <label htmlFor="edit-user-role" className="block text-xs font-semibold text-ink-muted mb-1">Role</label>
                <select
                  id="edit-user-role"
                  className={inputCls}
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                  disabled={editing?.id === me.id}
                  title={editing?.id === me.id ? "You can't change your own role" : undefined}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <div>
              <label htmlFor="edit-user-email" className="block text-xs font-semibold text-ink-muted mb-1">
                Email <span className="font-normal text-ink-muted/80">(lets them reset a forgotten password)</span>
              </label>
              <input
                id="edit-user-email"
                type="email"
                className={inputCls}
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                placeholder="name@example.com"
              />
            </div>
            <PasswordField
              id="edit-user-password"
              label="New password"
              value={editForm.password}
              onChange={(v) => setEditForm({ ...editForm, password: v })}
              placeholder="Leave empty to keep the current one"
            />
            {editForm.password && (
              <p className="text-xs text-ink-muted -mt-2">
                Saving a new password signs {editing?.id === me.id ? "you" : editing?.display_name} out of every device.
              </p>
            )}
            {editing?.oidc_linked && (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                <p className="text-xs text-ink-muted">Signs in with single sign-on</p>
                <button
                  type="button"
                  onClick={() => void unlinkUserSso()}
                  disabled={unlinkingSso}
                  className="text-xs font-medium text-rose-500 hover:underline disabled:opacity-50 cursor-pointer"
                >
                  {unlinkingSso ? "Unlinking…" : "Unlink SSO"}
                </button>
              </div>
            )}
            {editing && editing.id !== me.id && (
              <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
                <div>
                  <p className="text-xs font-medium text-ink">Sign out everywhere</p>
                  <p className="text-xs text-ink-muted">Ends every session without suspending the account.</p>
                </div>
                <button type="button" onClick={() => signOutEverywhere(editing)} disabled={busy} className={`${btnSecondary} py-1.5 text-xs`}>
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
              </div>
            )}
            {error && <Alert variant="error">{error}</Alert>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditing(null)} className={btnGhost}>
                Cancel
              </button>
              <button className={btnPrimary} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Save changes
              </button>
            </div>
          </form>
        </Modal>

        {/* Create */}
        <Modal open={creating} onClose={() => setCreating(false)} title="New user">
          <form onSubmit={saveCreate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="create-user-username" className="block text-xs font-semibold text-ink-muted mb-1">Username</label>
                <input
                  id="create-user-username"
                  className={inputCls}
                  value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  placeholder="jane.doe"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="create-user-name" className="block text-xs font-semibold text-ink-muted mb-1">Display name</label>
                <input
                  id="create-user-name"
                  className={inputCls}
                  value={createForm.display_name}
                  onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })}
                  placeholder="Jane Doe"
                />
              </div>
            </div>
            <PasswordField
              id="create-user-password"
              label="Password"
              value={createForm.password}
              onChange={(v) => setCreateForm({ ...createForm, password: v })}
              placeholder="At least 8 characters"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="create-user-role" className="block text-xs font-semibold text-ink-muted mb-1">Role</label>
                <select id="create-user-role" className={inputCls} value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}>
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label htmlFor="create-user-email" className="block text-xs font-semibold text-ink-muted mb-1">
                  Email <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="create-user-email"
                  type="email"
                  className={inputCls}
                  value={createForm.email}
                  onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                  placeholder="name@example.com"
                />
              </div>
            </div>
            {error && <Alert variant="error">{error}</Alert>}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setCreating(false)} className={btnGhost}>
                Cancel
              </button>
              <button className={btnPrimary} disabled={busy || !createForm.username || createForm.password.length < 8}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Create user
              </button>
            </div>
          </form>
        </Modal>

        {/* Suspend / reactivate */}
        <Modal
          open={!!userToSuspend}
          onClose={() => setUserToSuspend(null)}
          title={userToSuspend?.disabled ? `Reactivate ${userToSuspend?.display_name}?` : `Suspend ${userToSuspend?.display_name}?`}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              {userToSuspend?.disabled
                ? "They'll be able to sign in again. Their messages and settings are untouched."
                : "They're signed out right away, including any call in progress, and can't sign in until you reactivate them. Nothing is deleted."}
            </p>
            {error && <Alert variant="error">{error}</Alert>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setUserToSuspend(null)} className={btnGhost} disabled={busy}>
                Cancel
              </button>
              <button onClick={confirmSuspend} disabled={busy} className={userToSuspend?.disabled ? btnPrimary : btnDestructive}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {userToSuspend?.disabled ? "Reactivate" : "Suspend"}
              </button>
            </div>
          </div>
        </Modal>

        {/* Delete */}
        <Modal open={!!userToDelete} onClose={() => setUserToDelete(null)} title={`Delete ${userToDelete?.deleted ? "@" + userToDelete?.username : userToDelete?.display_name ?? ""}`}>
          <div className="space-y-4">
            {!userToDelete?.deleted && (
              <div className="grid gap-2" role="radiogroup" aria-label="How to delete">
                {(
                  [
                    {
                      key: "remove",
                      title: "Remove account",
                      text: "They can never sign in again. Their messages stay in other people's chats, shown as \"Deleted user\".",
                    },
                    {
                      key: "erase",
                      title: "Erase everything",
                      text: "Permanently deletes the account with all their messages, direct chats, calls, files and rooms. Groups they created pass to another member.",
                    },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    role="radio"
                    aria-checked={deleteMode === o.key}
                    onClick={() => setDeleteMode(o.key)}
                    className={`text-left rounded-xl border p-3 transition cursor-pointer ${
                      deleteMode === o.key
                        ? o.key === "erase"
                          ? "border-rose-500 bg-rose-500/10"
                          : "border-brand bg-brand/10"
                        : "border-line hover:bg-surface-hover"
                    }`}
                  >
                    <p className="text-sm font-semibold text-ink">{o.title}</p>
                    <p className="text-xs text-ink-muted mt-0.5">{o.text}</p>
                  </button>
                ))}
              </div>
            )}
            {deleteMode === "erase" && (
              <div className="space-y-2">
                <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-rose-500">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <p className="text-xs">
                    {userToDelete?.deleted
                      ? "This erases the removed account's remaining messages, calls and files. "
                      : ""}
                    This can't be undone. Type <span className="font-mono font-semibold">{userToDelete?.username}</span> to confirm.
                  </p>
                </div>
                <input
                  className={inputCls}
                  value={eraseConfirm}
                  onChange={(e) => setEraseConfirm(e.target.value)}
                  placeholder={userToDelete?.username}
                  aria-label="Type the username to confirm"
                  autoComplete="off"
                />
              </div>
            )}
            {error && <Alert variant="error">{error}</Alert>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setUserToDelete(null)} className={btnGhost}>
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={busy || (deleteMode === "erase" && eraseConfirm.trim() !== userToDelete?.username)}
                className={btnDestructive}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {deleteMode === "erase" ? "Erase permanently" : "Remove account"}
              </button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
