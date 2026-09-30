import { api } from "./api";
import { decryptMessageContent } from "./crypto";
import type { Message } from "./types";

// The server can't read end-to-end encrypted messages, so its search skips
// them. This searches the most recent page of each active conversation by
// decrypting on this device. Results carry the plaintext so they display
// like ordinary hits.
export async function searchEncryptedLocally(query: string, meID: number, signal: { cancelled: boolean }): Promise<Message[]> {
  const q = query.toLowerCase();
  const recent = await api.recentConversations();
  const fetchers: (() => Promise<Message[]>)[] = [];
  for (const m of recent.groups.slice(0, 20)) {
    if (m.group_id) fetchers.push(() => api.groupMessages(m.group_id!));
  }
  for (const m of recent.dms.slice(0, 20)) {
    const peer = m.sender_id === meID ? m.recipient_id : m.sender_id;
    if (peer) fetchers.push(() => api.directMessages(peer));
  }
  const hits: Message[] = [];
  for (const fetchPage of fetchers) {
    if (signal.cancelled) break;
    let page: Message[] = [];
    try {
      page = await fetchPage();
    } catch {
      continue;
    }
    for (const m of page) {
      if (!m.is_encrypted || m.deleted_at) continue;
      const plain = await decryptMessageContent(m);
      if (plain && plain.toLowerCase().includes(q)) hits.push({ ...m, is_encrypted: false, content: plain });
    }
  }
  return hits.sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
}
