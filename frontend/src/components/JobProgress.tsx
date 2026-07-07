import { useEffect, useRef, useState } from "react";
import { jobEventsUrl } from "../api/client";
import { openEventStream } from "../api/sse";
import type { JobEvent, JobState } from "../api/types";

const MAX_LINES = 500;

const STATE_STYLES: Record<JobState, string> = {
  queued: "chip-neutral",
  running: "chip-sky",
  succeeded: "chip-emerald",
  failed: "chip-rose",
  skipped: "chip-amber",
};

export function JobStateBadge({ state }: { state: JobState }) {
  return (
    <span className={STATE_STYLES[state]}>
      {state === "running" && (
        <span className="h-1.5 w-1.5 animate-pulse2 rounded-full bg-current" />
      )}
      {state}
    </span>
  );
}

/** Colored log line: ✓/OK → emerald, ✕/ERROR → rose, $/plain → ink. */
function logLineClass(line: string): string {
  const t = line.trimStart();
  if (t.startsWith("✓") || /\bOK\b/.test(t)) return "text-em-fg";
  if (t.startsWith("✕") || /ERROR/i.test(t)) return "text-rose-fg";
  return "text-ink";
}

interface JobProgressProps {
  jobId: string;
  onFinished?: (state: JobState) => void;
}

/** Live stdout panel for one job, fed by the /api/jobs/{id}/events SSE stream. */
export default function JobProgress({ jobId, onFinished }: JobProgressProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<JobState | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const doneRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    doneRef.current = false;
    setLines([]);
    setState(null);
    setDetail(null);
    setConnectionLost(false);

    let close: () => void = () => {};
    close = openEventStream<JobEvent>(
      jobEventsUrl(jobId),
      (event) => {
        if (event.type === "line") {
          setLines((prev) =>
            prev.length >= MAX_LINES
              ? [...prev.slice(prev.length - MAX_LINES + 1), event.line]
              : [...prev, event.line],
          );
        } else if (event.type === "state") {
          setState(event.state);
        } else {
          doneRef.current = true;
          setState(event.state);
          setDetail(event.detail);
          close();
          onFinishedRef.current?.(event.state);
        }
      },
      {
        // The server replays buffered lines on every (re)connect; reset so
        // the replay does not duplicate what we already rendered.
        onOpen: () => {
          setConnectionLost(false);
          setLines([]);
        },
        onConnectionError: () => {
          if (!doneRef.current) setConnectionLost(true);
        },
      },
    );
    return close;
  }, [jobId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines, detail]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        {state ? <JobStateBadge state={state} /> : <span className="chip-neutral">connecting…</span>}
        {connectionLost && (
          <span className="text-xs text-amber-fg">
            Connection lost — reconnecting…
          </span>
        )}
      </div>
      <div
        ref={logRef}
        className="h-48 overflow-y-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs leading-5 text-ink-2"
      >
        {lines.length === 0 && !detail && (
          <span className="text-ink-3">Waiting for output…</span>
        )}
        {lines.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${logLineClass(line)}`}>
            {line}
          </div>
        ))}
        {detail && (
          <div
            className={`mt-1 whitespace-pre-wrap break-words font-semibold ${
              state === "failed"
                ? "text-rose-fg"
                : state === "skipped"
                  ? "text-amber-fg"
                  : "text-em-fg"
            }`}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  );
}
