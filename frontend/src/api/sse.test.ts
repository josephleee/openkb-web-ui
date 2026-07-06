import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse";

function collect() {
  const events: string[] = [];
  const parser = createSseParser((data) => events.push(data));
  return { events, parser };
}

describe("createSseParser", () => {
  it("parses a single complete event", () => {
    const { events, parser } = collect();
    parser.feed('data: {"type":"line","line":"hello"}\n\n');
    expect(events).toEqual(['{"type":"line","line":"hello"}']);
  });

  it("parses multiple events arriving in one chunk", () => {
    const { events, parser } = collect();
    parser.feed('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles an event split across arbitrary chunk boundaries", () => {
    const { events, parser } = collect();
    parser.feed("da");
    parser.feed('ta: {"type":"text_del');
    parser.feed('ta","delta":"hi"}');
    expect(events).toEqual([]);
    parser.feed("\n");
    expect(events).toEqual([]);
    parser.feed("\n");
    expect(events).toEqual(['{"type":"text_delta","delta":"hi"}']);
  });

  it("handles CRLF line endings", () => {
    const { events, parser } = collect();
    parser.feed('data: {"x":1}\r\n\r\n');
    expect(events).toEqual(['{"x":1}']);
  });

  it("joins multi-line data fields with newlines", () => {
    const { events, parser } = collect();
    parser.feed("data: first\ndata: second\n\n");
    expect(events).toEqual(["first\nsecond"]);
  });

  it("ignores comment lines and non-data fields", () => {
    const { events, parser } = collect();
    parser.feed(": keepalive\nevent: message\nid: 7\nretry: 500\ndata: payload\n\n");
    expect(events).toEqual(["payload"]);
  });

  it("accepts data: with no space after the colon", () => {
    const { events, parser } = collect();
    parser.feed('data:{"tight":true}\n\n');
    expect(events).toEqual(['{"tight":true}']);
  });

  it("strips only one leading space from the value", () => {
    const { events, parser } = collect();
    parser.feed("data:  padded\n\n");
    expect(events).toEqual([" padded"]);
  });

  it("emits a trailing event on flush when the stream ends without a blank line", () => {
    const { events, parser } = collect();
    parser.feed('data: {"type":"done","answer":"x"}');
    expect(events).toEqual([]);
    parser.flush();
    expect(events).toEqual(['{"type":"done","answer":"x"}']);
  });

  it("flush is a no-op when nothing is buffered", () => {
    const { events, parser } = collect();
    parser.feed("data: a\n\n");
    parser.flush();
    expect(events).toEqual(["a"]);
  });

  it("treats an empty data line as an empty string entry", () => {
    const { events, parser } = collect();
    parser.feed("data:\ndata: b\n\n");
    expect(events).toEqual(["\nb"]);
  });
});
