import { request } from "./http";
import { postSse } from "./sse";
import type {
  ActivityEntry,
  ChatSessionDetail,
  ChatSessionSummary,
  ChatStreamEvent,
  DocumentEntry,
  EnqueuedJob,
  GraphData,
  HealthReport,
  Job,
  KbStatus,
  PageDetail,
  PageSummary,
  RemovePlanLine,
} from "./types";

/** Encode a slash-separated wiki path segment-by-segment (slashes preserved). */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

// --- Status / activity / health ---

export const getStatus = () => request<KbStatus>("/api/status");

export const getActivity = (limit = 50) =>
  request<ActivityEntry[]>(`/api/activity?limit=${limit}`);

export const getHealth = () => request<HealthReport>("/api/health");

// --- Wiki ---

export const getPages = () => request<PageSummary[]>("/api/pages");

export const getPage = (target: string) =>
  request<PageDetail>(`/api/pages/${encodePath(target)}`);

export const wikiFileUrl = (path: string) => `/api/wiki-file/${encodePath(path)}`;

// --- Documents & jobs ---

export const getDocuments = () => request<DocumentEntry[]>("/api/documents");

export function uploadDocument(file: File): Promise<EnqueuedJob> {
  const form = new FormData();
  form.append("file", file, file.name);
  return request<EnqueuedJob>("/api/documents/upload", { method: "POST", body: form });
}

export const addDocumentUrl = (url: string) =>
  request<EnqueuedJob>("/api/documents/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

export const getRemovePlan = (docName: string) =>
  request<RemovePlanLine[]>(
    `/api/documents/${encodeURIComponent(docName)}/remove-plan`,
    { method: "POST" },
  );

export const removeDocument = (docName: string, keepRaw: boolean) =>
  request<EnqueuedJob>(`/api/documents/${encodeURIComponent(docName)}/remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keep_raw: keepRaw }),
  });

export const recompileDocument = (docName: string) =>
  request<EnqueuedJob>(`/api/documents/${encodeURIComponent(docName)}/recompile`, {
    method: "POST",
  });

export const getJobs = () => request<Job[]>("/api/jobs");

export const jobEventsUrl = (jobId: string) =>
  `/api/jobs/${encodeURIComponent(jobId)}/events`;

// --- Chat & query ---

export const getChatSessions = () => request<ChatSessionSummary[]>("/api/chat/sessions");

export const createChatSession = () =>
  request<{ id: string } & Partial<ChatSessionDetail>>("/api/chat/sessions", {
    method: "POST",
  });

export const getChatSession = (id: string) =>
  request<ChatSessionDetail>(`/api/chat/sessions/${encodeURIComponent(id)}`);

export const deleteChatSession = (id: string) =>
  request<void>(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const sendChatMessage = (
  sessionId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
) =>
  postSse<ChatStreamEvent>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    { message },
    onEvent,
    signal,
  );

export const runQuery = (
  question: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
) => postSse<ChatStreamEvent>("/api/query", { question }, onEvent, signal);

// --- Graph ---

export const getGraph = () => request<GraphData>("/api/graph");
