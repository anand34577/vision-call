import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useAuth } from "../store/auth";
import { useChats } from "../store/chats";
import { Avatar, Modal, inputCls } from "./ui";
import { fmtTime } from "../lib/util";
import type { Convo, Message } from "../lib/types";

function textOf(m: Message, decrypted: Record<number, string | null>): string {
  if (m.deleted_at) return "Message deleted";
  if (m.is_encrypted) return decrypted[m.id] ?? (m.id in decrypted ? "Encrypted message (not available on this device)" : "Decrypting…");
  return m.content || m.file?.name || "";
}

// A thread: the first message and the replies posted under it.
export default function ThreadModal({ convo, root, onClose }: { convo: Convo; root: Message; onClose: () => void }) {
  const me = useAuth((s) => s.me)!;
  const { messagesByDm, messagesByGroup, decryptedContent, loadThread, sendMessage } = useChats();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  const bucket = (convo.kind === "dm" ? messagesByDm[convo.peerID] : messagesByGroup[convo.groupID]) ?? [];
  const replies = bucket.filter((m) => m.thread_root_id === root.id);

  useEffect(() => {
    let alive = true;
    loadThread(root.id).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [root.id, loadThread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [replies.length]);

  const send = () => {
    if (!text.trim()) return;
    sendMessage(convo, text, undefined, undefined, { threadRootID: root.id });
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const bubble = (m: Message) => (
    <div key={m.id} className="flex items-start gap-2.5">
      <Avatar name={m.sender?.display_name ?? "?"} id={m.sender_id} fileId={m.sender?.avatar_file_id ?? null} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-xs">
          <span className="font-semibold">{m.sender_id === me.id ? "You" : m.sender?.display_name ?? "Someone"}</span>
          <span className="text-zinc-400 ml-2">{fmtTime(m.sent_at)}</span>
          {m.pending && <span className="text-zinc-400 ml-2">sending…</span>}
          {m.failed && <span className="text-rose-500 ml-2">not sent</span>}
        </p>
        <p className="text-sm break-words whitespace-pre-wrap">{textOf(m, decryptedContent)}</p>
      </div>
    </div>
  );

  return (
    <Modal open onClose={onClose} title="Thread">
      <div className="space-y-4">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">{bubble(root)}</div>
        <p className="text-xs font-semibold text-zinc-500">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
          {loading && <Loader2 className="inline h-3 w-3 animate-spin ml-2" />}
        </p>
        <div className="max-h-72 overflow-y-auto space-y-3 pr-1">
          {replies.map(bubble)}
          <div ref={endRef} />
        </div>
        <div className="flex items-center gap-2">
          <input className={inputCls} autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} placeholder="Reply in thread…" aria-label="Reply in thread" />
          <button onClick={send} disabled={!text.trim()} className="h-10 w-10 shrink-0 rounded-xl bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center disabled:opacity-30" aria-label="Send reply">
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </Modal>
  );
}
