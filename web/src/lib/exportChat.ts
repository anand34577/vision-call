import { api } from "./api";
import { decryptMessageContent } from "./crypto";
import type { Convo, Message } from "./types";

// Builds a readable transcript of a whole conversation and downloads it.
// Done here rather than on the server because end-to-end encrypted messages
// are only readable on a device that holds the key.
export async function exportChat(c: Convo, title: string): Promise<void> {
  const all = new Map<number, Message>();
  let before: number | undefined;
  for (let page = 0; page < 200; page++) {
    const batch = c.kind === "dm" ? await api.directMessages(c.peerID, before) : await api.groupMessages(c.groupID, before);
    for (const m of batch) all.set(m.id, m);
    if (batch.length < 50) break;
    before = Math.min(...batch.map((m) => m.id));
  }
  const lines: string[] = [];
  const sorted = [...all.values()].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || a.id - b.id);
  for (const m of sorted) {
    const when = new Date(m.sent_at).toLocaleString();
    const who = m.sender?.display_name ?? `User ${m.sender_id}`;
    let text = m.deleted_at ? "(deleted)" : m.is_encrypted ? ((await decryptMessageContent(m)) ?? "(can't decrypt on this device)") : m.content;
    if (m.file) text += `${text ? "  " : ""}[file: ${m.file.name}]`;
    lines.push(`[${when}] ${who}: ${text}`);
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chat-${title.replace(/[^\w.-]+/g, "_")}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
