import type { ReactNode } from "react";
import { errorMessage } from "../api/http";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin text-ink-3 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}

export function PageLoading() {
  return (
    <div className="space-y-3" aria-hidden="true">
      <div className="skeleton h-7 w-1/3" />
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-40 w-full" />
      <div className="skeleton h-4 w-5/6" />
      <div className="skeleton h-4 w-4/6" />
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-8 text-center">
      <div className="mb-3.5 grid h-10 w-10 place-items-center rounded-[11px] bg-rose-bg text-rose-fg">
        <svg
          width="20"
          height="20"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M8 1.8 1.2 13.6h13.6z" />
          <path d="M8 6.2v3.1M8 11.4v.1" />
        </svg>
      </div>
      <div className="font-display text-[15px] font-semibold text-ink">
        Backend unreachable
      </div>
      <div className="mt-1.5 max-w-sm break-words text-[13px] leading-relaxed text-ink-3">
        {errorMessage(error)}
      </div>
      {onRetry && (
        <button className="btn mt-4" onClick={onRetry}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" />
          </svg>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
      <div className="mb-3.5 grid h-10 w-10 place-items-center rounded-[11px] bg-accent-soft text-accent">
        <svg
          width="20"
          height="20"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 4.5h11v9h-11z" />
          <path d="M2.5 7.5h11M6 4.5V2.5h4v2" />
        </svg>
      </div>
      <div className="font-display text-[15px] font-semibold text-ink">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-xs text-ink-3">{hint}</div>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
