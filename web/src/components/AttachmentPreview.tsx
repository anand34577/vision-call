import { useEffect, useMemo, useState } from "react";
import { FileText, Film, Loader2, Music, Plus, Send, X } from "lucide-react";
import { Modal, btnGhost, btnPrimary } from "./ui";
import { fmtBytes } from "../lib/util";

/**
 * Preview of the files about to be sent, WhatsApp style: thumbnails, a
 * caption for the first file, remove before sending, and upload progress.
 */
export default function AttachmentPreview({
  files,
  onAddMore,
  onRemove,
  onCancel,
  onSend,
  progress,
  sending,
  encrypted,
}: {
  files: File[];
  onAddMore: () => void;
  onRemove: (index: number) => void;
  onCancel: () => void;
  onSend: (caption: string) => void;
  /** 0..1 across all files, or null when not sending. */
  progress: number | null;
  sending: boolean;
  encrypted: boolean;
}) {
  const [caption, setCaption] = useState("");
  const urls = useMemo(() => files.map((f) => (f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => urls.forEach((u) => u && URL.revokeObjectURL(u)), [urls]);
  useEffect(() => {
    if (files.length === 0) setCaption("");
  }, [files.length]);

  const total = files.reduce((n, f) => n + f.size, 0);
  const single = files.length === 1;

  return (
    <Modal open={files.length > 0} onClose={() => !sending && onCancel()} title={single ? "Send file" : `Send ${files.length} files`}>
      <div className="space-y-4">
        <div className={single ? "" : "grid grid-cols-3 gap-2 max-h-72 overflow-y-auto"}>
          {files.map((f, i) => {
            const url = urls[i];
            const isImage = f.type.startsWith("image/");
            const isVideo = f.type.startsWith("video/");
            return (
              <div
                key={`${f.name}-${i}`}
                className={`relative rounded-xl overflow-hidden border border-line bg-surface-hover animate-rise ${single ? "max-h-80 flex items-center justify-center" : "aspect-square"}`}
                style={{ "--i": i } as React.CSSProperties}
              >
                {isImage && url ? (
                  <img src={url} alt={f.name} className={single ? "max-h-80 w-auto object-contain" : "h-full w-full object-cover"} />
                ) : isVideo && url ? (
                  <video src={url} className={single ? "max-h-80 w-full" : "h-full w-full object-cover"} muted controls={single} />
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center gap-1.5 p-3 text-center min-h-28">
                    {f.type.startsWith("audio/") ? (
                      <Music className="h-7 w-7 text-brand" />
                    ) : isVideo ? (
                      <Film className="h-7 w-7 text-brand" />
                    ) : (
                      <FileText className="h-7 w-7 text-brand" />
                    )}
                    <p className="text-xs font-medium text-ink line-clamp-2 break-all">{f.name}</p>
                    <p className="text-[11px] text-ink-muted">{fmtBytes(f.size)}</p>
                  </div>
                )}
                {!sending && (
                  <button
                    type="button"
                    onClick={() => onRemove(i)}
                    aria-label={`Remove ${f.name}`}
                    className="absolute top-1.5 right-1.5 h-7 w-7 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          {!single && !sending && (
            <button
              type="button"
              onClick={onAddMore}
              className="aspect-square rounded-xl border border-dashed border-line flex flex-col items-center justify-center gap-1 text-ink-muted hover:text-ink hover:bg-surface-hover cursor-pointer"
            >
              <Plus className="h-5 w-5" />
              <span className="text-xs">Add more</span>
            </button>
          )}
        </div>

        <p className="text-xs text-ink-muted">
          {files.length} {files.length === 1 ? "file" : "files"} · {fmtBytes(total)}
          {encrypted ? " · only the caption is end-to-end encrypted; the file itself is NOT encrypted and is readable on your server" : ""}
        </p>

        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !sending) {
              e.preventDefault();
              onSend(caption);
            }
          }}
          placeholder="Add a caption…"
          aria-label="Caption"
          disabled={sending}
          className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
          autoFocus
        />

        {progress !== null && (
          <div className="space-y-1.5" aria-live="polite">
            <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
              <div className="h-full bg-brand transition-all duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="text-xs text-ink-muted">Uploading… {Math.round(progress * 100)}%</p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          {single && !sending && (
            <button type="button" onClick={onAddMore} className={btnGhost}>
              <Plus className="h-4 w-4" /> Add more
            </button>
          )}
          <button type="button" onClick={onCancel} className={btnGhost} disabled={sending}>
            Cancel
          </button>
          <button type="button" onClick={() => onSend(caption)} className={btnPrimary} disabled={sending || files.length === 0}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
          </button>
        </div>
      </div>
    </Modal>
  );
}
