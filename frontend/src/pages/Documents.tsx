import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  addDocumentUrl,
  getDocuments,
  getJobs,
  getRemovePlan,
  recompileDocument,
  removeDocument,
  uploadDocument,
} from "../api/client";
import { errorMessage } from "../api/http";
import type { DocumentEntry, Job, JobState, RemovePlanAction } from "../api/types";
import { SUPPORTED_EXTENSIONS, hasSupportedExtension } from "../api/types";
import ConfirmDialog from "../components/ConfirmDialog";
import JobProgress, { JobStateBadge } from "../components/JobProgress";
import { EmptyState, ErrorState, Spinner } from "../components/States";
import { formatDateTime, formatRelative } from "../lib/format";

const PLAN_ACTION_STYLES: Record<RemovePlanAction, string> = {
  DELETE: "text-rose-fg",
  MODIFY: "text-amber-fg",
  REGISTRY: "text-neutral-fg",
  PAGEINDEX: "text-sky-fg",
};

const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set([
  "succeeded",
  "failed",
  "skipped",
]);

function UploadDropzone({
  onFiles,
  uploading,
}: {
  onFiles: (files: File[]) => void;
  uploading: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!uploading) onFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      className={`flex h-full min-h-[8.5rem] cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed p-6 text-center transition-colors ${
        dragging
          ? "border-accent bg-accent-soft"
          : "border-line-strong hover:border-accent-line"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !uploading) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="Upload documents"
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        accept={SUPPORTED_EXTENSIONS.join(",")}
        onChange={(e) => {
          if (e.target.files) onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      {uploading ? (
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner /> Uploading…
        </div>
      ) : (
        <>
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent"
            aria-hidden="true"
          >
            <path d="M12 15V4M8 8l4-4 4 4" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <div className="mt-3 text-sm font-medium text-ink">
            Drop files to add — or click to browse
          </div>
          <div className="mt-2 max-w-[400px] font-mono text-xs text-ink-3">
            {SUPPORTED_EXTENSIONS.join(" ")}
          </div>
        </>
      )}
    </div>
  );
}

function JobsPanel({
  jobs,
  expandedId,
  onToggle,
  onJobFinished,
}: {
  jobs: Job[];
  expandedId: string | null;
  onToggle: (id: string | null) => void;
  onJobFinished: () => void;
}) {
  if (jobs.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-ink-3">
        No jobs yet. Uploads, removals, and recompiles appear here with live logs.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {jobs.map((job) => {
        const active = job.state === "queued" || job.state === "running";
        const expanded = expandedId === job.id;
        return (
          <li key={job.id} className="py-2">
            <div className="flex items-center gap-3">
              <JobStateBadge state={job.state} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink" title={job.label}>
                  {job.label}
                </div>
                <div className="font-mono text-[11px] text-ink-3">
                  {job.kind} · created {formatRelative(job.created_at)}
                  {job.finished_at && ` · finished ${formatDateTime(job.finished_at)}`}
                </div>
                {job.detail && !expanded && (
                  <div className="mt-0.5 truncate text-xs text-ink-2" title={job.detail}>
                    {job.detail}
                  </div>
                )}
              </div>
              {(active || expanded) && (
                <button className="btn btn-sm shrink-0" onClick={() => onToggle(expanded ? null : job.id)}>
                  {expanded ? "Hide log" : "Show log"}
                </button>
              )}
            </div>
            {expanded && (
              <div className="mt-2">
                <JobProgress jobId={job.id} onFinished={onJobFinished} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function DocumentsPage() {
  const queryClient = useQueryClient();
  const documents = useQuery({ queryKey: ["documents"], queryFn: getDocuments });
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: getJobs,
    refetchInterval: (query) =>
      query.state.data?.some((j) => j.state === "queued" || j.state === "running")
        ? 2_000
        : 10_000,
  });

  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [removeTarget, setRemoveTarget] = useState<DocumentEntry | null>(null);
  const [keepRaw, setKeepRaw] = useState(false);
  const [recompileTarget, setRecompileTarget] = useState<DocumentEntry | null>(null);

  const invalidateKbState = () => {
    for (const key of ["documents", "status", "jobs", "pages", "activity", "health", "graph"]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  // Refresh KB-derived queries whenever a job reaches a terminal state, based
  // on the polled jobs list. (JobProgress also reports completion over SSE,
  // but it is only mounted for the single expanded log panel — completion
  // must not depend on which log the user happens to have open.)
  const seenJobStatesRef = useRef<Map<string, JobState> | null>(null);
  useEffect(() => {
    const list = jobs.data;
    if (!list) return;
    const prev = seenJobStatesRef.current;
    seenJobStatesRef.current = new Map<string, JobState>(
      list.map((job) => [job.id, job.state]),
    );
    if (!prev) return; // initial snapshot: nothing finished *while watching*
    const justFinished = list.some(
      (job) => TERMINAL_JOB_STATES.has(job.state) && prev.get(job.id) !== job.state,
    );
    if (justFinished) invalidateKbState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.data]);

  const trackJob = (jobId: string) => {
    setExpandedJobId(jobId);
    void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    void queryClient.invalidateQueries({ queryKey: ["status"] });
  };

  const handleFiles = async (files: File[]) => {
    const errors = files
      .filter((f) => !hasSupportedExtension(f.name))
      .map((f) => `${f.name}: unsupported file type`);
    const accepted = files.filter((f) => hasSupportedExtension(f.name));
    setUploading(true);
    let lastJobId: string | null = null;
    for (const file of accepted) {
      try {
        const { job_id } = await uploadDocument(file);
        lastJobId = job_id;
      } catch (err) {
        errors.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setUploading(false);
    setUploadErrors(errors);
    if (lastJobId) trackJob(lastJobId);
  };

  const urlMutation = useMutation({
    mutationFn: addDocumentUrl,
    onSuccess: ({ job_id }) => {
      setUrl("");
      trackJob(job_id);
    },
  });

  const onAddUrl = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (/^https?:\/\//i.test(value)) urlMutation.mutate(value);
  };

  const plan = useQuery({
    queryKey: ["remove-plan", removeTarget?.doc_name],
    queryFn: () => getRemovePlan(removeTarget!.doc_name),
    enabled: removeTarget !== null,
    staleTime: 0,
    gcTime: 0,
  });

  const removeMutation = useMutation({
    mutationFn: ({ docName, keep }: { docName: string; keep: boolean }) =>
      removeDocument(docName, keep),
    onSuccess: ({ job_id }) => {
      setRemoveTarget(null);
      setKeepRaw(false);
      trackJob(job_id);
    },
  });

  const recompileMutation = useMutation({
    mutationFn: recompileDocument,
    onSuccess: ({ job_id }) => {
      setRecompileTarget(null);
      trackJob(job_id);
    },
  });

  const docs = documents.data ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Documents</h1>
          <p className="text-sm text-ink-3">
            {docs.length} document{docs.length === 1 ? "" : "s"} in the knowledge base
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Upload files
            </h2>
            <UploadDropzone onFiles={(files) => void handleFiles(files)} uploading={uploading} />
            {uploadErrors.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {uploadErrors.map((err, i) => (
                  <li key={i} className="text-xs text-rose-fg">
                    {err}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Add from URL
            </h2>
            <form onSubmit={onAddUrl} className="flex gap-2">
              <input
                className="input"
                type="url"
                placeholder="https://example.com/paper.pdf"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-label="Document URL"
              />
              <button
                className="btn btn-primary shrink-0"
                disabled={!/^https?:\/\//i.test(url.trim()) || urlMutation.isPending}
              >
                {urlMutation.isPending ? <Spinner className="h-4 w-4 text-accent-fg" /> : "Add"}
              </button>
            </form>
            <p className="mt-2 text-[11px] text-ink-3">
              Web pages are fetched and converted to markdown.
            </p>
            {urlMutation.isError && (
              <p className="mt-2 text-xs text-rose-fg">
                {errorMessage(urlMutation.error)}
              </p>
            )}
          </div>
        </div>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">
            Library
          </h2>
          {documents.isError ? (
            <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
          ) : documents.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-5 w-5" />
            </div>
          ) : docs.length === 0 ? (
            <EmptyState
              title="No documents yet"
              hint="Upload a file or add a URL above — OpenKB will compile it into the wiki."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[0.07em] text-ink-3">
                    <th className="py-2 pr-4 font-semibold">Name</th>
                    <th className="py-2 pr-4 font-semibold">Type</th>
                    <th className="py-2 pr-4 font-semibold">Pages</th>
                    <th className="py-2 pr-4 font-semibold">Summary</th>
                    <th className="py-2 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {docs.map((doc) => (
                    <tr key={doc.doc_name} className="group">
                      <td className="max-w-xs py-2.5 pr-4">
                        <div className="truncate font-medium text-ink" title={doc.name}>
                          {doc.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-ink-3" title={doc.doc_name}>
                          {doc.doc_name}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={
                            doc.display_type === "pageindex" ? "chip-violet" : "chip-neutral"
                          }
                        >
                          {doc.display_type}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 font-mono tabular-nums text-ink-2">
                        {doc.pages ?? "—"}
                      </td>
                      <td className="py-2.5 pr-4">
                        {doc.has_summary ? (
                          <Link
                            to={`/wiki/summaries/${doc.doc_name}`}
                            className="text-accent hover:underline"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex justify-end gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <button className="btn btn-sm" onClick={() => setRecompileTarget(doc)}>
                            Recompile
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => {
                              setKeepRaw(false);
                              setRemoveTarget(doc);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-1 flex items-center gap-2.5 text-sm font-semibold text-ink">
            Jobs
            {(jobs.data ?? []).some((j) => j.state === "queued" || j.state === "running") && (
              <span className="h-1.5 w-1.5 animate-pulse2 rounded-full bg-amber-fg" />
            )}
          </h2>
          {jobs.isError ? (
            <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
          ) : (
            <JobsPanel
              jobs={jobs.data ?? []}
              expandedId={expandedJobId}
              onToggle={setExpandedJobId}
              onJobFinished={invalidateKbState}
            />
          )}
        </section>
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove “${removeTarget?.name ?? ""}”?`}
        confirmLabel="Remove"
        danger
        busy={removeMutation.isPending}
        disabled={plan.isLoading || plan.isError}
        onConfirm={() =>
          removeTarget &&
          removeMutation.mutate({ docName: removeTarget.doc_name, keep: keepRaw })
        }
        onClose={() => {
          setRemoveTarget(null);
          setKeepRaw(false);
        }}
      >
        {plan.isLoading ? (
          <div className="flex items-center gap-2 text-ink-2">
            <Spinner /> Computing removal plan…
          </div>
        ) : plan.isError ? (
          <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
        ) : (
          <>
            <p className="text-ink-2">
              The following changes will be applied:
            </p>
            <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs">
              {(plan.data ?? []).map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className={`w-20 shrink-0 font-semibold ${PLAN_ACTION_STYLES[line.action] ?? ""}`}>
                    {line.action}
                  </span>
                  <span className="break-all text-ink-2">
                    {line.target}
                  </span>
                </li>
              ))}
              {(plan.data ?? []).length === 0 && (
                <li className="text-ink-3">Nothing to change.</li>
              )}
            </ul>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                checked={keepRaw}
                onChange={(e) => setKeepRaw(e.target.checked)}
              />
              Keep the original file in raw/
            </label>
          </>
        )}
        {removeMutation.isError && (
          <p className="mt-2 text-xs text-rose-fg">
            {errorMessage(removeMutation.error)}
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={recompileTarget !== null}
        title={`Recompile “${recompileTarget?.name ?? ""}”?`}
        confirmLabel="Recompile"
        busy={recompileMutation.isPending}
        onConfirm={() => recompileTarget && recompileMutation.mutate(recompileTarget.doc_name)}
        onClose={() => setRecompileTarget(null)}
      >
        <p className="text-ink-2">
          The LLM regenerates this document&apos;s summary, concept, and entity pages from
          its stored source. Manual edits to those generated pages will be overwritten.
        </p>
        {recompileMutation.isError && (
          <p className="mt-2 text-xs text-rose-fg">
            {errorMessage(recompileMutation.error)}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
