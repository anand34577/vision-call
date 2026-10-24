import { useEffect, useMemo, useState } from "react";
import { Hash } from "lucide-react";
import { useAuth } from "../store/auth";
import { useChats } from "../store/chats";
import { useDirectory } from "../store/directory";
import { Avatar, Modal, PresenceDot, inputCls } from "./ui";

type Item =
  | { kind: "dm"; id: number; name: string; sub: string; fileId: number | null; status?: string }
  | { kind: "group"; id: number; name: string; sub: string; fileId: number | null };

// QuickSwitcher (Ctrl/Cmd+K) jumps to any person or group by typing part of
// its name, without leaving the keyboard.
export function QuickSwitcher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const me = useAuth((s) => s.me);
  const users = useDirectory((s) => s.users);
  const groups = useChats((s) => s.groups);
  const unread = useChats((s) => s.unread);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuery("");
        setIndex(0);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: Item[] = [
      ...groups.map((g): Item => ({ kind: "group", id: g.id, name: g.name, sub: `${g.members.length} members`, fileId: g.avatar_file_id })),
      ...users
        .filter((u) => u.id !== me?.id && !u.disabled && !u.deleted)
        .map((u): Item => ({ kind: "dm", id: u.id, name: u.display_name, sub: `@${u.username}`, fileId: u.avatar_file_id, status: u.status })),
    ];
    const unreadOf = (i: Item) => unread[i.kind === "dm" ? `dm:${i.id}` : `g:${i.id}`] ?? 0;
    return all
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q))
      // Unread chats first, then names that start with the query.
      .sort((a, b) =>
        unreadOf(b) - unreadOf(a) ||
        Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) ||
        a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [query, groups, users, me, unread]);

  const pick = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    window.location.hash = "chats";
    if (item.kind === "dm") useChats.getState().openDm(item.id);
    else useChats.getState().openGroup(item.id);
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Jump to a chat">
      <input
        autoFocus
        className={inputCls}
        placeholder="Type a name…"
        aria-label="Search people and groups"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(items[index]);
          }
        }}
      />
      <ul className="mt-3 space-y-0.5" role="listbox" aria-label="Matches">
        {items.map((item, i) => {
          const n = unread[item.kind === "dm" ? `dm:${item.id}` : `g:${item.id}`] ?? 0;
          return (
            <li key={`${item.kind}:${item.id}`} role="option" aria-selected={i === index}>
              <button
                type="button"
                // Move, not enter: a list opening under a resting cursor
                // mustn't steal the keyboard selection.
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => pick(item)}
                className={`w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-left cursor-pointer transition ${i === index ? "bg-brand/10" : "hover:bg-surface-hover"}`}
              >
                <span className="relative flex shrink-0">
                  {item.kind === "group" && item.fileId == null ? (
                    <span className="h-8 w-8 rounded-full bg-surface-hover flex items-center justify-center text-ink-muted">
                      <Hash className="h-4 w-4" />
                    </span>
                  ) : (
                    <Avatar name={item.name} id={item.id} fileId={item.fileId} size="sm" />
                  )}
                  {item.kind === "dm" && item.status && <PresenceDot status={item.status} className="absolute -bottom-0.5 -right-0.5" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-ink truncate">{item.name}</span>
                  <span className="block text-xs text-ink-muted truncate">{item.sub}</span>
                </span>
                {n > 0 && <span className="text-[11px] font-semibold rounded-full bg-brand text-white px-1.5 min-w-5 text-center">{n}</span>}
              </button>
            </li>
          );
        })}
        {items.length === 0 && <li className="px-2.5 py-6 text-center text-sm text-ink-muted">No one matches “{query}”.</li>}
      </ul>
    </Modal>
  );
}
