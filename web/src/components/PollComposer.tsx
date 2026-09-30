import { FormEvent, useState } from "react";
import { Plus, X } from "lucide-react";
import { Modal, Switch, btnGhost, btnPrimary, inputCls } from "./ui";

// Dialog for creating a poll: a question plus 2-10 options.
export default function PollComposer({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (poll: { question: string; options: string[]; multi: boolean }) => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);

  const cleaned = options.map((o) => o.trim()).filter(Boolean);
  const valid = question.trim().length > 0 && cleaned.length >= 2;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onCreate({ question: question.trim(), options: cleaned, multi });
    setQuestion("");
    setOptions(["", ""]);
    setMulti(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Create a poll">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="poll-question" className="block text-xs font-semibold text-zinc-500 mb-1">Question</label>
          <input id="poll-question" className={inputCls} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} autoFocus placeholder="Where should we have lunch?" />
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-500">Options</p>
          {options.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={inputCls}
                maxLength={100}
                value={o}
                aria-label={`Option ${i + 1}`}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => setOptions((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {options.length > 2 && (
                <button type="button" className="h-9 w-9 shrink-0 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {options.length < 10 && (
            <button type="button" className={btnGhost} onClick={() => setOptions((list) => [...list, ""])}>
              <Plus className="h-4 w-4" /> Add option
            </button>
          )}
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Allow multiple answers</p>
          <Switch checked={multi} onChange={setMulti} label="Allow multiple answers" />
        </div>
        <p className="text-xs text-zinc-400">Polls are visible to everyone in the chat, so they are not end-to-end encrypted.</p>
        <button className={`${btnPrimary} w-full`} disabled={!valid}>Send poll</button>
      </form>
    </Modal>
  );
}
