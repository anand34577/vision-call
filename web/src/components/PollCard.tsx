import { Lock } from "lucide-react";
import { useChats } from "../store/chats";
import type { Poll } from "../lib/types";

// A poll inside a chat bubble: tap an option to vote (tap again to undo).
export function PollCard({ poll, meID, canClose, mine }: { poll: Poll; meID: number; canClose: boolean; mine: boolean }) {
  const votePoll = useChats((s) => s.votePoll);
  const closePoll = useChats((s) => s.closePoll);
  const voters = new Set(poll.options.flatMap((o) => o.votes));
  const total = poll.options.reduce((n, o) => n + o.votes.length, 0);
  return (
    <div className="min-w-[14rem] max-w-full space-y-2" role="group" aria-label={`Poll: ${poll.question}`}>
      <p className="font-semibold text-sm break-words">{poll.question}</p>
      <p className="text-[11px] opacity-75">
        {poll.closed ? "Poll closed" : poll.multi ? "Select one or more" : "Select one"} · {voters.size} {voters.size === 1 ? "vote" : "votes"}
      </p>
      <ul className="space-y-1.5">
        {poll.options.map((o) => {
          const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
          const picked = o.votes.includes(meID);
          return (
            <li key={o.id}>
              <button
                type="button"
                disabled={poll.closed}
                aria-pressed={picked}
                onClick={() => votePoll(poll.id, o.id)}
                className={`relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition disabled:cursor-default ${
                  picked ? "border-current" : mine ? "border-white/30 hover:border-white/60" : "border-zinc-300 dark:border-zinc-600 hover:border-blue-500"
                }`}
              >
                <span
                  className={`absolute inset-y-0 left-0 ${mine ? "bg-white/25" : "bg-blue-500/20"}`}
                  style={{ width: `${pct}%` }}
                  aria-hidden="true"
                />
                <span className="relative flex items-center justify-between gap-2">
                  <span className="break-words">{picked ? "✓ " : ""}{o.text}</span>
                  <span className="shrink-0 text-xs font-semibold">{o.votes.length} · {pct}%</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {canClose && !poll.closed && (
        <button type="button" onClick={() => closePoll(poll.id)} className="text-[11px] font-semibold underline opacity-80 hover:opacity-100 inline-flex items-center gap-1">
          <Lock className="h-3 w-3" /> Close poll
        </button>
      )}
    </div>
  );
}
