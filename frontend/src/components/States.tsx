import type { ReactNode } from "react";
import { errorMessage } from "../api/http";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`animate-spin text-slate-400 ${className}`}
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
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-6 w-6" />
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
    <div className="card border-rose-200 bg-rose-50 p-4 dark:border-rose-900/60 dark:bg-rose-950/40">
      <div className="text-sm font-medium text-rose-700 dark:text-rose-300">
        Something went wrong
      </div>
      <div className="mt-1 break-words text-sm text-rose-600/90 dark:text-rose-400/90">
        {errorMessage(error)}
      </div>
      {onRetry && (
        <button className="btn btn-sm mt-3" onClick={onRetry}>
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center dark:border-slate-700">
      <div className="text-sm font-medium text-slate-600 dark:text-slate-300">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-xs text-slate-400 dark:text-slate-500">{hint}</div>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
