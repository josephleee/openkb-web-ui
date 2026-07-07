import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Disables buttons and overlay dismissal while the action runs. */
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}

export default function ConfirmDialog({
  open,
  title,
  confirmLabel = "Confirm",
  danger,
  busy,
  disabled,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog while it is open; restore it on close.
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Match the overlay/Cancel behavior: no dismissal while the action runs.
        if (!busy) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Minimal focus trap: keep Tab cycling inside the dialog.
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 backdrop-blur-[3px]"
        style={{ background: "var(--backdrop)" }}
        onClick={busy ? undefined : onClose}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="card relative w-full max-w-lg rounded-2xl p-5 shadow-pop outline-none"
      >
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        {children && <div className="mt-3 text-sm">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={busy || disabled}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
