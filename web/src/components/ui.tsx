import React, { useEffect, useId, useRef, useState } from "react";
import { X, CheckCircle2, AlertTriangle, XCircle, Info, Loader2, MessageCircle } from "lucide-react";
import { avatarColor, initials } from "../lib/util";
import { cx } from "../lib/cx";
import { useToast } from "../store/toast";

export function Avatar({
  name,
  id,
  fileId,
  size = "md",
  className = "",
}: {
  name: string;
  id: number;
  fileId?: number | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const dim = {
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-14 w-14 text-lg",
    xl: "h-24 w-24 text-3xl",
  }[size];
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [fileId]);

  if (fileId != null && !imageFailed) {
    return (
      <img
        key={fileId}
        src={`/api/files/${fileId}`}
        alt={name}
        className={`${dim} rounded-full object-cover bg-zinc-200 dark:bg-zinc-800 ring-1 ring-black/5 dark:ring-white/5 shadow-xs shrink-0 ${className}`}
        onError={() => setImageFailed(true)}
      />
    );
  }
  return (
    <div
      className={`${dim} ${avatarColor(id)} rounded-full flex items-center justify-center font-semibold text-white select-none ring-1 ring-white/5 shadow-xs shrink-0 ${className}`}
    >
      {initials(name)}
    </div>
  );
}

export function PresenceDot({ status, className = "" }: { status: string; className?: string }) {
  const color =
    status === "online"
      ? "bg-emerald-500 shadow-sm shadow-emerald-500/50"
      : status === "away"
        ? "bg-amber-400"
        : status === "dnd"
          ? "bg-rose-500"
          : "bg-zinc-400 dark:bg-zinc-600";
  return (
    <span
      className={`relative inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[#0A0E1A] ${status === "online" ? "ring-pulse" : ""} ${color} ${className}`}
      role="img"
      aria-label={`Status: ${status}`}
    />
  );
}

// useFocusTrap — shared dialog a11y behavior: focus the first focusable
// element (or [autofocus]) on open, cycle Tab within the container, close on
// Escape, and restore focus to whatever was focused before opening. Used by
// Modal and any other full-screen dialog (e.g. IncomingCallModal) so the
// trap logic exists in exactly one place.
export function useFocusTrap(
  open: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const first = initialFocusRef?.current ?? container?.querySelector<HTMLElement>("[autofocus]") ?? container?.querySelector<HTMLElement>(
      "[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
    );
    // React applies autoFocus itself (no attribute reaches the DOM), before
    // this effect runs: keep that focus instead of moving it to the first button.
    if (!container?.contains(document.activeElement)) (first ?? container)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
      ));
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const firstFocusable = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open, containerRef]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const titleID = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, onClose, dialogRef);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-[2px] p-0 sm:p-4 animate-fade-in"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleID}
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-surface text-ink border border-line shadow-2xl overflow-hidden animate-sheet-in sm:animate-modal-in max-h-[92dvh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <h2 id={titleID} className="font-semibold text-sm text-ink font-display tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-hover transition cursor-pointer"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// Switch is an accessible on/off toggle for boolean settings
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
        checked ? "bg-blue-600" : "bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
          checked ? "translate-x-[22px]" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export const inputCls =
  "w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-ink placeholder:text-ink-muted outline-none transition duration-150 focus:border-brand focus:ring-2 focus:ring-brand/20 shadow-xs";

export const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-brand hover:bg-brand-hover px-4 py-2 text-sm font-semibold text-white shadow-md active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 cursor-pointer";

export const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink-secondary hover:text-ink hover:bg-surface-hover active:scale-[0.98] transition-all duration-150 cursor-pointer";

export const btnSecondary =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium text-ink shadow-xs hover:bg-surface-hover hover:border-line-strong active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 cursor-pointer";

export const btnDestructive =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-rose-600 hover:bg-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-rose-600/20 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 cursor-pointer";

// Alert shared banner
const alertStyles = {
  success: {
    wrap: "text-emerald-300 bg-emerald-950/50 border-emerald-800/60",
    Icon: CheckCircle2,
  },
  error: {
    wrap: "text-rose-300 bg-rose-950/50 border-rose-800/60",
    Icon: XCircle,
  },
  warning: {
    wrap: "text-amber-300 bg-amber-950/50 border-amber-800/60",
    Icon: AlertTriangle,
  },
  info: {
    wrap: "text-blue-300 bg-blue-950/50 border-blue-800/60",
    Icon: Info,
  },
} as const;

export function Alert({
  variant,
  children,
}: {
  variant: keyof typeof alertStyles;
  children: React.ReactNode;
}) {
  const { wrap, Icon } = alertStyles[variant];
  return (
    <p
      className={`flex items-start gap-2.5 text-sm p-3.5 rounded-lg border ${wrap}`}
      role={variant === "error" || variant === "warning" ? "alert" : "status"}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <span className="leading-snug">{children}</span>
    </p>
  );
}

export function Badge({
  variant = "neutral",
  children,
  className = "",
}: {
  variant?: "primary" | "accent" | "success" | "warning" | "destructive" | "neutral" | "prismatic";
  children: React.ReactNode;
  className?: string;
}) {
  const styles = {
    primary: "bg-brand/15 text-brand border border-brand/30",
    accent: "bg-brand/15 text-brand border border-brand/30",
    // prismatic kept as alias for primary
    prismatic: "bg-brand/15 text-brand border border-brand/30",
    success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
    destructive: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
    neutral: "bg-surface-hover text-ink-secondary border-line",
  }[variant];

  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${styles} ${className}`}>
      {children}
    </span>
  );
}

// IconBtn — consistent 40px touch target for icon-only buttons.
// Card — one elevated surface for independent content blocks. Do not nest.
export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-surface text-ink shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

// SectionHeader — icon + title + optional action, one pattern everywhere.
export function SectionHeader({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <span className="h-8 w-8 rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate">{title}</h2>
          {hint && <p className="text-xs text-zinc-500 mt-0.5">{hint}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

// Field — visible label + optional hint + error, never placeholder-as-label.
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1.5">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-zinc-500 mt-1">{hint}</p>}
      {error && (
        <p className="text-xs text-rose-600 dark:text-rose-400 mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function IconBtn({
  label,
  title,
  onClick,
  disabled,
  active,
  className = "",
  children,
}: {
  label: string;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 transition border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-600/25"
          : "text-zinc-500 dark:text-zinc-400 border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 hover:border-zinc-200 dark:hover:border-zinc-700"
      } ${className}`}
    >
      {children}
    </button>
  );
}

// Skeleton rows for loading states (preferred over spinners for lists).
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
          <div className="skeleton h-10 w-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="skeleton h-3 w-2/5 rounded" />
            <div className="skeleton h-2.5 w-3/5 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="ambient-glow p-8 text-center flex flex-col items-center gap-2.5">
      <div className="h-12 w-12 rounded-2xl bg-white dark:bg-white/[0.06] border border-zinc-200 dark:border-white/10 shadow-sm flex items-center justify-center text-blue-600 dark:text-blue-400">
        {icon}
      </div>
      <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{title}</p>
      {hint && <p className="text-xs text-zinc-500 max-w-xs">{hint}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

// Button — the one button component. variant/size/loading/icon cover every
// call site; prefer this over the deprecated btnPrimary/btnGhost/... strings.
const buttonVariants = {
  primary: "bg-brand hover:bg-brand-hover text-white shadow-md shadow-brand/20",
  secondary:
    "border border-line bg-surface text-ink shadow-xs hover:bg-surface-hover hover:border-line-strong",
  ghost: "text-ink-secondary hover:text-ink hover:bg-surface-hover",
  destructive: "bg-rose-600 hover:bg-rose-500 text-white shadow-md shadow-rose-600/20",
} as const;

const buttonSizes = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-5 text-base gap-2.5",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  icon,
  className = "",
  children,
  ...props
}: {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
  loading?: boolean;
  icon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-semibold active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none transition-all duration-150 cursor-pointer",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// Menu — a single accessible dropdown/popover primitive. Closes on Escape,
// outside click, or item select; returns focus to the trigger on close.
export function Menu({
  trigger,
  children,
  align = "end",
  placement = "down",
  className = "",
}: {
  trigger: (state: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
  placement?: "down" | "up";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cx("relative inline-block", className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: triggerRef })}
      {open && (
        <div
          role="menu"
          className={cx(
            "absolute z-40 min-w-[11rem] rounded-lg border border-line bg-elevated shadow-lg py-1 animate-modal-in",
            placement === "down" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {React.Children.map(children, (child) =>
            React.isValidElement(child)
              ? React.cloneElement(child as React.ReactElement<{ onSelect?: () => void }>, {
                  onSelect: () => setOpen(false),
                })
              : child,
          )}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  onSelect,
  destructive,
  disabled,
  children,
}: {
  onClick?: () => void;
  onSelect?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClick?.();
        onSelect?.();
      }}
      className={cx(
        "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition disabled:opacity-40 disabled:pointer-events-none cursor-pointer",
        destructive ? "text-error hover:bg-error/10" : "text-ink hover:bg-surface-hover",
      )}
    >
      {children}
    </button>
  );
}

// Tooltip — hover/focus label for icon-only controls.
export function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {React.cloneElement(children, { "aria-describedby": visible ? id : undefined } as React.HTMLAttributes<HTMLElement>)}
      {visible && (
        <span
          id={id}
          role="tooltip"
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 whitespace-nowrap rounded-md bg-elevated border border-line px-2 py-1 text-xs text-ink shadow-md z-50"
        >
          {label}
        </span>
      )}
    </span>
  );
}

// Tabs — accessible tab list; scrolls horizontally instead of wrapping so it
// stays usable on narrow screens.
export function Tabs({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: { key: string; label: string; icon?: React.ReactNode }[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cx("flex gap-1 overflow-x-auto", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
          className={cx(
            "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition cursor-pointer",
            active === tab.key
              ? "bg-brand text-white shadow-sm"
              : "text-ink-secondary hover:text-ink hover:bg-surface-hover",
          )}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export const selectCls =
  "w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-ink outline-none transition duration-150 focus:border-brand focus:ring-2 focus:ring-brand/20 shadow-xs cursor-pointer";

export function Select({ className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(selectCls, className)} {...props} />;
}

export const textareaCls =
  "w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-ink placeholder:text-ink-muted outline-none transition duration-150 focus:border-brand focus:ring-2 focus:ring-brand/20 shadow-xs resize-none";

export function Textarea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(textareaCls, className)} {...props} />;
}

// Skeleton — single block/card shimmer, complements SkeletonList.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={cx("skeleton rounded-lg", className)} aria-hidden="true" />;
}

// Toast — global success/error/info feedback. Mount <ToastHost/> once at the
// app root; raise toasts anywhere with `toast.success("...")` from
// store/toast, or the useToast() hook inside components.
const toastStyles = {
  success: { wrap: "border-emerald-500/30", icon: "text-emerald-400", bar: "bg-emerald-400", Icon: CheckCircle2 },
  error: { wrap: "border-rose-500/30", icon: "text-rose-400", bar: "bg-rose-400", Icon: XCircle },
  info: { wrap: "border-sky-500/30", icon: "text-sky-400", bar: "bg-sky-400", Icon: Info },
  message: { wrap: "border-brand/40", icon: "text-brand", bar: "bg-brand", Icon: MessageCircle },
} as const;

export function ToastHost() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed top-3 inset-x-3 sm:inset-x-auto sm:top-auto sm:bottom-4 sm:right-4 z-[60] flex flex-col gap-2 items-stretch sm:items-end pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const { wrap, icon, bar, Icon } = toastStyles[t.variant];
        const clickable = !!t.onClick;
        return (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            onClick={() => {
              if (!t.onClick) return;
              t.onClick();
              dismiss(t.id);
            }}
            className={cx(
              "pointer-events-auto relative overflow-hidden flex items-start gap-3 w-full sm:w-80 rounded-xl border bg-zinc-900/95 text-zinc-100 px-3.5 py-3 text-sm shadow-2xl backdrop-blur animate-toast-in",
              wrap,
              clickable && "cursor-pointer hover:bg-zinc-800/95",
            )}
          >
            <Icon className={cx("h-4 w-4 shrink-0 mt-0.5", icon)} />
            <div className="flex-1 min-w-0">
              {t.title && <p className="font-semibold leading-snug truncate">{t.title}</p>}
              <p className={cx("leading-snug", t.title ? "text-zinc-300 line-clamp-2" : "")}>{t.message}</p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              aria-label="Dismiss"
              className="shrink-0 opacity-60 hover:opacity-100 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <span
              className={cx("toast-timer absolute left-0 bottom-0 h-0.5 w-full opacity-70", bar)}
              style={{ animationDuration: `${t.duration}ms` }}
            />
          </div>
        );
      })}
    </div>
  );
}
