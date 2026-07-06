import { ApiError, extractDetail } from "./http";

export interface SseParser {
  /** Feed a decoded chunk; may contain any number of partial/complete frames. */
  feed(chunk: string): void;
  /** Emit any event still buffered when the stream ends. */
  flush(): void;
}

/**
 * Incremental parser for the `data: <payload>\n\n` SSE framing. Handles
 * chunks split at arbitrary byte boundaries, CRLF line endings, multi-line
 * data fields (joined with \n per the SSE spec), and ignores comment lines
 * and non-data fields (event:, id:, retry:).
 */
export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0) {
      onData(dataLines.join("\n"));
      dataLines = [];
    }
  };

  const processLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  };

  return {
    feed(chunk) {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
        nl = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer !== "") {
        let line = buffer;
        buffer = "";
        if (line.endsWith("\r")) line = line.slice(0, -1);
        processLine(line);
      }
      dispatch();
    },
  };
}

/**
 * POST-SSE consumer (EventSource is GET-only): sends JSON, reads the
 * streaming response body, and emits each JSON `data:` payload.
 */
export async function postSse<T>(
  url: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new ApiError(res.status, await extractDetail(res));
  if (!res.body) throw new Error("Streaming response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseParser((data) => {
    let parsed: T;
    try {
      parsed = JSON.parse(data) as T;
    } catch {
      return; // tolerate keepalive/non-JSON frames
    }
    onEvent(parsed);
  });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  parser.feed(decoder.decode());
  parser.flush();
}

/**
 * GET-SSE subscription via native EventSource (auto-reconnecting). Returns a
 * close function. `onOpen` fires on every (re)connection — the job-events
 * endpoint replays its buffered lines on reconnect, so callers should reset
 * accumulated state there.
 */
export function openEventStream<T>(
  url: string,
  onEvent: (event: T) => void,
  hooks?: { onOpen?: () => void; onConnectionError?: () => void },
): () => void {
  const source = new EventSource(url);
  source.onopen = () => hooks?.onOpen?.();
  source.onmessage = (e: MessageEvent<string>) => {
    let parsed: T;
    try {
      parsed = JSON.parse(e.data) as T;
    } catch {
      return;
    }
    onEvent(parsed);
  };
  source.onerror = () => hooks?.onConnectionError?.();
  return () => source.close();
}
