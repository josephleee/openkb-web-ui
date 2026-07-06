import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type DragEvent, type FormEvent } from "react";
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
import type { DocumentEntry, Job, RemovePlanAction } from "../api/types";
import { SUPPORTED_EXTENSIONS, hasSupportedExtension } from "../api/types";
import ConfirmDialog from "../components/ConfirmDialog";
import JobProgress, { JobStateBadge } from "../components/JobProgress";
import { EmptyState, ErrorState, Spinner } from "../components/States";
import { formatDateTime, formatRelative } from "../lib/format";

const PLAN_ACTION_STYLES: Record<RemovePlanAction, string> = {
  DELETE: "text-rose-600 dark:text-rose-400",
  MODIFY: "text-amber-600 dark:text-amber-400",
  REGISTRY: "text-slate-500 dark:text-slate-400",
  PAGEINDEX: "text-violet-600 dark:text-violet-400",
};

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
      className={`flex h-full min-h-[8.5rem] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center transition-colors ${
        dragging
          ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10"
          : "border-slate-300 hover:border-slate-400 dark:border-slate-700 dark:hover:border-slate-600"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      role="button"
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
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Uploading…
        </div>
      ) : (
        <>
          <div className="text-sm font-medium text-slate-600 dark:text-slate-300">
            Drop files here or click to browse
          </div>
          <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
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
      <p className="px-1 py-2 text-xs text-slate-400 dark:text-slate-500">
        No jobs yet. Uploads, removals, and recompiles appear here with live progress.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {jobs.map((job) => {
        const active = job.state === "queued" || job.state === "running";
        const expanded = expandedId === job.id;
        return (
          <li key={job.id} className="py-2">
            <div className="flex items-center gap-3">
              <JobStateBadge state={job.state} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-700 dark:text-slate-200" title={job.label}>
                  {job.label}
                </div>
                <div className="text-[11px] text-slate-400 dark:text-slate-500">
                  {job.kind} · created {formatRelative(job.created_at)}
                  {job.finished_at && ` · finished ${formatDateTime(job.finished_at)}`}
                </div>
                {job.detail && !expanded && (
                  <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400" title={job.detail}>
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
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Documents</h1>
          <p className="text-sm text-slate-400 dark:text-slate-500">
            {docs.length} document{docs.length === 1 ? "" : "s"} in the knowledge base
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Upload files
            </h2>
            <UploadDropzone onFiles={(files) => void handleFiles(files)} uploading={uploading} />
            {uploadErrors.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {uploadErrors.map((err, i) => (
                  <li key={i} className="text-xs text-rose-600 dark:text-rose-400">
                    {err}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
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
                {urlMutation.isPending ? <Spinner className="h-4 w-4 text-white" /> : "Add"}
              </button>
            </form>
            <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
              PDFs are downloaded; HTML pages are converted to markdown.
            </p>
            {urlMutation.isError && (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
                {errorMessage(urlMutation.error)}
              </p>
            )}
          </div>
        </div>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
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
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-700 dark:text-slate-500">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Type</th>
                    <th className="py-2 pr-4 font-medium">Pages</th>
                    <th className="py-2 pr-4 font-medium">Summary</th>
                    <th className="py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {docs.map((doc) => (
                    <tr key={doc.doc_name}>
                      <td className="max-w-xs py-2.5 pr-4">
                        <div className="truncate font-medium text-slate-700 dark:text-slate-200" title={doc.name}>
                          {doc.name}
                        </div>
                        <div className="truncate font-mono text-[11px] text-slate-400 dark:text-slate-500" title={doc.doc_name}>
                          {doc.doc_name}
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`chip ${
                            doc.display_type === "pageindex"
                              ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
                              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                          }`}
                        >
                          {doc.display_type}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums text-slate-500 dark:text-slate-400">
                        {doc.pages ?? "—"}
                      </td>
                      <td className="py-2.5 pr-4">
                        {doc.has_summary ? (
                          <Link
                            to={`/wiki/summaries/${doc.doc_name}`}
                            className="text-sky-600 hover:underline dark:text-sky-400"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-slate-300 dark:text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex gap-1.5">
                          <button className="btn btn-sm" onClick={() => setRecompileTarget(doc)}>
                            Recompile
                          </button>
                          <button
                            className="btn btn-sm text-rose-600 dark:text-rose-400"
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
          <h2 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Jobs</h2>
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
          <div className="flex items-center gap-2 text-slate-500">
            <Spinner /> Computing removal plan…
          </div>
        ) : plan.isError ? (
          <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />
        ) : (
          <>
            <p className="text-slate-600 dark:text-slate-300">
              The following changes will be applied:
            </p>
            <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto rounded-lg bg-slate-50 p-3 font-mono text-xs dark:bg-slate-950">
              {(plan.data ?? []).map((line, i) => (
                <li key={i} className="flex gap-2">
                  <span className={`w-20 shrink-0 font-semibold ${PLAN_ACTION_STYLES[line.action] ?? ""}`}>
                    {line.action}
                  </span>
                  <span className="break-all text-slate-600 dark:text-slate-300">
                    {line.target}
                  </span>
                </li>
              ))}
              {(plan.data ?? []).length === 0 && (
                <li className="text-slate-400">Nothing to change.</li>
              )}
            </ul>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
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
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
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
        <p className="text-slate-600 dark:text-slate-300">
          The LLM regenerates this document&apos;s summary, concept, and entity pages from
          its stored source. Manual edits to those generated pages will be overwritten.
        </p>
        {recompileMutation.isError && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {errorMessage(recompileMutation.error)}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
