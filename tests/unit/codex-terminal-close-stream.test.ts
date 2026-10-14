import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  terminateCodexHttpStreamOnTerminal,
  encodeResponseSseEvent,
} from "../../open-sse/executors/codex.ts";
import {
  isResponsesTerminalLine,
  RESPONSES_TERMINAL_EVENT_TYPES,
} from "../../open-sse/executors/opencodeMuseSpark.ts";

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe("isResponsesTerminalLine & RESPONSES_TERMINAL_EVENT_TYPES", () => {
  it("includes all authoritative Responses terminal types", () => {
    assert.ok(RESPONSES_TERMINAL_EVENT_TYPES.has("response.completed"));
    assert.ok(RESPONSES_TERMINAL_EVENT_TYPES.has("response.incomplete"));
    assert.ok(RESPONSES_TERMINAL_EVENT_TYPES.has("response.failed"));
    assert.ok(RESPONSES_TERMINAL_EVENT_TYPES.has("response.cancelled"));
    assert.ok(RESPONSES_TERMINAL_EVENT_TYPES.has("response.canceled"));
    assert.ok(RESPONSES_TERMINAL_EVENT_TYPES.has("response.done"));
  });

  it("detects terminal response lines", () => {
    assert.equal(
      isResponsesTerminalLine('data: {"type":"response.completed","id":"resp_123"}'),
      true
    );
    assert.equal(
      isResponsesTerminalLine('data: {"type":"response.incomplete","id":"resp_123"}'),
      true
    );
    assert.equal(isResponsesTerminalLine('data: {"type":"response.failed","id":"resp_123"}'), true);
  });

  it("returns false for non-terminal or malformed lines", () => {
    assert.equal(isResponsesTerminalLine('data: {"type":"response.output_item.added"}'), false);
    assert.equal(isResponsesTerminalLine('data: {"type":"response.output_text.delta"}'), false);
    assert.equal(isResponsesTerminalLine("event: response.completed"), false);
    assert.equal(isResponsesTerminalLine("data: [DONE]"), false);
    assert.equal(isResponsesTerminalLine("plain text line"), false);
    assert.equal(isResponsesTerminalLine("data: not-a-json"), false);
  });
});

describe("encodeResponseSseEvent terminal detection", () => {
  it("marks response.completed and response.failed as terminal", () => {
    const completed = encodeResponseSseEvent(JSON.stringify({ type: "response.completed" }));
    assert.equal(completed.terminal, true);

    const failed = encodeResponseSseEvent(JSON.stringify({ type: "response.failed" }));
    assert.equal(failed.terminal, true);
  });

  it("marks response.incomplete, response.cancelled, and response.done as terminal", () => {
    const incomplete = encodeResponseSseEvent(JSON.stringify({ type: "response.incomplete" }));
    assert.equal(incomplete.terminal, true);

    const cancelled = encodeResponseSseEvent(JSON.stringify({ type: "response.cancelled" }));
    assert.equal(cancelled.terminal, true);

    const done = encodeResponseSseEvent(JSON.stringify({ type: "response.done" }));
    assert.equal(done.terminal, true);
  });

  it("does not mark in-flight events as terminal", () => {
    const inProgress = encodeResponseSseEvent(JSON.stringify({ type: "response.in_progress" }));
    assert.equal(inProgress.terminal, false);

    const outputItem = encodeResponseSseEvent(
      JSON.stringify({ type: "response.output_item.added" })
    );
    assert.equal(outputItem.terminal, false);
  });
});

describe("terminateCodexHttpStreamOnTerminal", () => {
  it("terminates stream immediately upon forwarding response.completed, cutting off subsequent pings", async () => {
    let canceled = false;
    const encoder = new TextEncoder();

    // Stream that emits tool_call events, response.completed, and then tries to linger with pings
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1"}}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'event: response.completed\ndata: {"type":"response.completed","id":"resp_abc"}\n\n'
          )
        );
        // Trailing events that upstream might send while idling
        controller.enqueue(encoder.encode(": ping\n\n"));
        controller.enqueue(encoder.encode(": ping\n\n"));
      },
      cancel() {
        canceled = true;
      },
    });

    const upstreamResponse = new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const guardedResponse = terminateCodexHttpStreamOnTerminal(upstreamResponse);
    const text = await readAll(guardedResponse);

    assert.ok(text.includes("response.completed"), "response.completed must be delivered");
    assert.ok(text.includes("function_call"), "prior tool call events must be delivered");
    assert.ok(!text.includes(": ping"), "trailing pings after terminal line must be cut off");
    assert.equal(canceled, true, "upstream reader must be cancelled upon terminal line");
  });

  it("terminates stream on response.incomplete terminal", async () => {
    let canceled = false;
    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: response.incomplete\ndata: {"type":"response.incomplete","id":"resp_inc"}\n\n'
          )
        );
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      },
      cancel() {
        canceled = true;
      },
    });

    const upstreamResponse = new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const guardedResponse = terminateCodexHttpStreamOnTerminal(upstreamResponse);
    const text = await readAll(guardedResponse);

    assert.ok(text.includes("response.incomplete"));
    assert.ok(!text.includes(": keepalive"));
    assert.equal(canceled, true);
  });

  it("passes normal EOF streams through without truncation if no terminal line was seen", async () => {
    const stream = 'event: response.created\ndata: {"type":"response.created"}\n\n';
    const guardedResponse = terminateCodexHttpStreamOnTerminal(sseResponse(stream));
    const text = await readAll(guardedResponse);

    assert.ok(text.includes("response.created"));
  });

  it("returns non-SSE responses unmodified", async () => {
    const json = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const guarded = terminateCodexHttpStreamOnTerminal(json);
    assert.equal(await guarded.text(), '{"ok":true}');
  });
});
