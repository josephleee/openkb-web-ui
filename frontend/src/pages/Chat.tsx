import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  getChatSessions,
  sendChatMessage,
} from "../api/client";
import { errorMessage } from "../api/http";
import type { ChatSessionDetail, ChatSessionSummary, ChatTurn } from "../api/types";
import ConfirmDialog from "../components/ConfirmDialog";
import Markdown from "../components/Markdown";
import { EmptyState, ErrorState, PageLoading, Spinner } from "../components/States";
import { formatRelative } from "../lib/format";

interface ToolCall {
  name: string;
  arguments: string;
}

interface PendingTurn {
  user: string;
  text: string;
  tools: ToolCall[];
  error: string | null;
  streaming: boolean;
}

function prettyArguments(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function ToolTrail({ tools }: { tools: ToolCall[] }) {
  if (tools.length === 0) return null;
  return (
    <details className="mb-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <summary className="cursor-pointer select-none bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
        {tools.length} tool call{tools.length > 1 ? "s" : ""}
      </summary>
      <ol className="divide-y divide-slate-100 dark:divide-slate-800">
        {tools.map((tool, i) => (
          <li key={i} className="px-3 py-2">
            <div className="font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">
              {tool.name}
            </div>
            {tool.arguments && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                {prettyArguments(tool.arguments)}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2 text-sm text-white">
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  tools,
  streaming,
}: {
  text: string;
  tools: ToolCall[];
  streaming?: boolean;
}) {
  return (
    <div className="card px-4 py-3">
      <ToolTrail tools={tools} />
      {text ? (
        <Markdown assumeResolvedWikilinks>{text}</Markdown>
      ) : streaming ? (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Spinner /> Thinking…
        </div>
      ) : null}
      {streaming && text && (
        <span className="mt-1 inline-block h-3.5 w-1.5 animate-pulse bg-slate-400" aria-hidden="true" />
      )}
    </div>
  );
}

function SessionSidebar({
  sessions,
  currentId,
  onNew,
  creating,
  onDelete,
  loading,
  error,
  onRetry,
}: {
  sessions: ChatSessionSummary[];
  currentId: string | undefined;
  onNew: () => void;
  creating: boolean;
  onDelete: (session: ChatSessionSummary) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const sorted = sessions
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-3 dark:border-slate-800">
        <button className="btn btn-primary w-full" onClick={onNew} disabled={creating}>
          {creating ? "Creating…" : "New chat"}
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        )}
        {!loading && error && (
          <div className="px-3 py-2">
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Could not load sessions.
            </p>
            <button className="btn btn-sm mt-1.5" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {!loading && !error && sorted.length === 0 && (
          <p className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">
            No sessions yet.
          </p>
        )}
        {sorted.map((session) => (
          <div
            key={session.id}
            className={`group flex items-center gap-1 rounded-md ${
              session.id === currentId
                ? "bg-indigo-50 dark:bg-indigo-500/10"
                : "hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <Link
              to={`/chat/${session.id}`}
              className="min-w-0 flex-1 px-3 py-2"
              title={session.title}
            >
              <div
                className={`truncate text-sm ${
                  session.id === currentId
                    ? "font-medium text-indigo-700 dark:text-indigo-300"
                    : "text-slate-600 dark:text-slate-300"
                }`}
              >
                {session.title || "New session"}
              </div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500">
                {session.turn_count} turn{session.turn_count === 1 ? "" : "s"} ·{" "}
                {formatRelative(session.updated_at)}
              </div>
            </Link>
            <button
              type="button"
              className="mr-1 shrink-0 rounded p-1 text-slate-400 opacity-0 hover:bg-rose-100 hover:text-rose-600 focus:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-rose-500/15 dark:hover:text-rose-400"
              onClick={() => onDelete(session)}
              title="Delete session"
              aria-label={`Delete session ${session.title || session.id}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                />
              </svg>
            </button>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({ queryKey: ["chat-sessions"], queryFn: getChatSessions });
  const sessionQuery = useQuery({
    queryKey: ["chat-session", sessionId],
    queryFn: () => getChatSession(sessionId!),
    enabled: !!sessionId,
  });

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [toolTrails, setToolTrails] = useState<Record<number, ToolCall[]>>({});
  const [deleteTarget, setDeleteTarget] = useState<ChatSessionSummary | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const askSentRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setPending(null);
    setToolTrails({});
    setDraft("");
    askSentRef.current = false;
    return () => {
      // Kill any in-flight stream when leaving the session (or unmounting) so
      // its late events can never write into another session's view.
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, [sessionId]);

  const turns: ChatTurn[] = sessionQuery.data?.turns ?? [];
  const isStreaming = pending !== null && pending.streaming;

  const send = async (raw: string) => {
    const message = raw.trim();
    // A pending turn that already errored (streaming: false) may be replaced
    // by a new send; only an actively streaming turn blocks the composer.
    if (!message || !sessionId || (pending && pending.streaming)) return;
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    const baseIndex =
      queryClient.getQueryData<ChatSessionDetail>(["chat-session", sessionId])?.turns
        .length ?? 0;

    let text = "";
    const tools: ToolCall[] = [];
    let finished = false;
    let doneAnswer: string | null = null;
    setPending({ user: message, text: "", tools: [], error: null, streaming: true });

    try {
      await sendChatMessage(sessionId, message, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "text_delta") {
          text += event.delta;
          setPending((p) => (p ? { ...p, text } : p));
        } else if (event.type === "tool_call") {
          tools.push({ name: event.name, arguments: event.arguments });
          setPending((p) => (p ? { ...p, tools: [...tools] } : p));
        } else if (event.type === "done") {
          finished = true;
          const answer = event.answer || text;
          doneAnswer = answer;
          queryClient.setQueryData<ChatSessionDetail>(
            ["chat-session", sessionId],
            (old) =>
              old
                ? { ...old, turns: [...old.turns, { user: message, assistant: answer }] }
                : old,
          );
          if (tools.length > 0) {
            setToolTrails((prev) => ({ ...prev, [baseIndex]: [...tools] }));
          }
          setPending(null);
          void queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
        } else if (event.type === "error") {
          if (finished) {
            // Post-done error: the answer streamed fine but the backend failed
            // to persist the turn (record_turn threw). Undo the optimistic
            // append and re-show the turn with the error attached.
            queryClient.setQueryData<ChatSessionDetail>(
              ["chat-session", sessionId],
              (old) =>
                old && old.turns[old.turns.length - 1]?.user === message
                  ? { ...old, turns: old.turns.slice(0, -1) }
                  : old,
            );
            setToolTrails((prev) => {
              if (!(baseIndex in prev)) return prev;
              const next = { ...prev };
              delete next[baseIndex];
              return next;
            });
            setPending({
              user: message,
              text: doneAnswer ?? text,
              tools: [...tools],
              error: event.message,
              streaming: false,
            });
            void queryClient.invalidateQueries({ queryKey: ["chat-session", sessionId] });
          } else {
            finished = true;
            setPending((p) => (p ? { ...p, error: event.message, streaming: false } : p));
          }
        }
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (!finished) {
        setPending((p) =>
          p ? { ...p, error: "The stream ended unexpectedly.", streaming: false } : p,
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setPending((p) => (p ? { ...p, error: errorMessage(err), streaming: false } : p));
    }
  };

  // Quick-ask handoff from the Dashboard: pre-send the question into a fresh session.
  const ask = (location.state as { ask?: string } | null)?.ask;
  useEffect(() => {
    if (
      ask &&
      sessionId &&
      sessionQuery.data &&
      sessionQuery.data.turns.length === 0 &&
      !pending &&
      !askSentRef.current
    ) {
      askSentRef.current = true;
      void send(ask);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, sessionId, sessionQuery.data]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, pending?.text, pending?.tools.length, pending?.error]);

  const createMutation = useMutation({
    mutationFn: createChatSession,
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      navigate(`/chat/${session.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteChatSession(id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      queryClient.removeQueries({ queryKey: ["chat-session", id] });
      setDeleteTarget(null);
      if (id === sessionId) navigate("/chat");
    },
  });

  const submitDraft = () => {
    if (!draft.trim() || isStreaming) return;
    const message = draft;
    setDraft("");
    void send(message);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitDraft();
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // During IME composition (CJK input) Enter commits the composition, not
    // the message. Safari reports it only via the legacy keyCode 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitDraft();
    }
  };

  return (
    <div className="flex h-full">
      <SessionSidebar
        sessions={sessionsQuery.data ?? []}
        currentId={sessionId}
        onNew={() => createMutation.mutate()}
        creating={createMutation.isPending}
        onDelete={setDeleteTarget}
        loading={sessionsQuery.isLoading}
        error={sessionsQuery.isError}
        onRetry={() => void sessionsQuery.refetch()}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {!sessionId ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              title="Chat with your knowledge base"
              hint="Answers stream in with a provenance trail of the wiki files the agent consulted."
            >
              <button
                className="btn btn-primary"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending}
              >
                Start a new chat
              </button>
            </EmptyState>
          </div>
        ) : sessionQuery.isLoading ? (
          <PageLoading />
        ) : sessionQuery.isError ? (
          <div className="p-6">
            <ErrorState error={sessionQuery.error} onRetry={() => void sessionQuery.refetch()} />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-4 p-6">
                {turns.length === 0 && !pending && (
                  <EmptyState
                    title="No messages yet"
                    hint="Ask anything about the documents compiled into this knowledge base."
                  />
                )}
                {turns.map((turn, i) => (
                  <div key={i} className="space-y-4">
                    <UserBubble text={turn.user} />
                    <AssistantBubble text={turn.assistant} tools={toolTrails[i] ?? []} />
                  </div>
                ))}
                {pending && (
                  <div className="space-y-4">
                    <UserBubble text={pending.user} />
                    <AssistantBubble
                      text={pending.text}
                      tools={pending.tools}
                      streaming={pending.streaming}
                    />
                    {pending.error && (
                      <div className="card flex items-start justify-between gap-3 border-rose-200 bg-rose-50 px-4 py-3 dark:border-rose-900/60 dark:bg-rose-950/40">
                        <div className="text-sm text-rose-700 dark:text-rose-300">
                          {pending.error}
                        </div>
                        <button className="btn btn-sm shrink-0" onClick={() => setPending(null)}>
                          Dismiss
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            <form
              onSubmit={onSubmit}
              className="border-t border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="mx-auto flex max-w-3xl items-end gap-2">
                <textarea
                  className="input resize-none"
                  rows={2}
                  placeholder={isStreaming ? "Waiting for the answer…" : "Ask a question… (Enter to send)"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onComposerKeyDown}
                  disabled={isStreaming}
                  aria-label="Chat message"
                />
                <button className="btn btn-primary shrink-0" disabled={isStreaming || !draft.trim()}>
                  {isStreaming ? <Spinner className="h-4 w-4 text-white" /> : "Send"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete chat session?"
        confirmLabel="Delete"
        danger
        busy={deleteMutation.isPending}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        onClose={() => setDeleteTarget(null)}
      >
        <p className="text-slate-600 dark:text-slate-300">
          “{deleteTarget?.title || deleteTarget?.id}” and its history will be permanently
          deleted.
        </p>
        {deleteMutation.isError && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            {errorMessage(deleteMutation.error)}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
