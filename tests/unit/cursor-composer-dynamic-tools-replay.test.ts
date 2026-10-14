import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";

import { newStreamCtx, processFrame } from "../../open-sse/executors/cursor.ts";
import { driveCursorH2 } from "../../open-sse/executors/cursor/streamDriver.ts";
import {
  decodeAgentServerMessage,
  openAIToolsToMcpDefs,
} from "../../open-sse/utils/cursorAgentProtobuf.ts";
import {
  composerDynamicToolsPacket1,
  composerDynamicToolsPacket2,
} from "../fixtures/cursor-composer-dynamic-tools-frames.ts";

// Replays Cursor frames captured live from composer-2.5 for one tool turn.
// Composer looks the declared tool up through Cursor's GetDynamicTools before
// calling it; Cursor writes KV checkpoints while that lookup is in flight, and
// the exec_mcp for read_file arrives in the model's next step. A checkpoint
// written mid-lookup used to end the Composer turn, so the call was dropped
// and the client got a narration-only finish_reason "stop".

const readFileTools = openAIToolsToMcpDefs([
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
]);

function connectFrame(hex: string): Buffer {
  const payload = Buffer.from(hex, "hex");
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function fakeH2() {
  const req = new EventEmitter() as EventEmitter & {
    close(): void;
    write(data: Buffer): boolean;
    pause(): void;
    resume(): void;
  };
  req.close = () => {};
  req.write = () => true;
  req.pause = () => {};
  req.resume = () => {};
  const client = new EventEmitter() as EventEmitter & { close(): void };
  client.close = () => {};
  return { req, client };
}

test("composer: exec_mcp after a GetDynamicTools lookup becomes the tool call", async () => {
  const ctx = newStreamCtx("cursor/composer-2.5", () => {});
  const { req, client } = fakeH2();
  const done = driveCursorH2(
    { req, client, initialBytes: Buffer.concat(composerDynamicToolsPacket1.map(connectFrame)) },
    ctx,
    {
      mcpTools: readFileTools,
      debugEnabled: false,
      debugLog: () => {},
      onFrame: (payload, acked, opts) => processFrame(payload, ctx, acked, opts),
    }
  );
  // The second packet arrives after the first has been scanned, the way
  // Cursor delivered it: the lookup result and next step come ~1.3 s later.
  await nextTurn();
  req.emit("data", Buffer.concat(composerDynamicToolsPacket2.map(connectFrame)));
  await done;

  assert.equal(ctx.endReason, "tool_calls");
  assert.equal(ctx.toolCalls.length, 1);
  assert.equal(ctx.toolCalls[0].name, "read_file");
  assert.deepEqual(JSON.parse(ctx.toolCalls[0].argumentsJson), { path: "/etc/hosts" });
});

test("composer: a KV checkpoint with no tool call in flight still ends the turn", () => {
  const ctx = newStreamCtx("cursor/composer-2.5", () => {});
  const acked = new Set<string>();
  // The same narration with the lookup removed: a plain reply followed by
  // Cursor's checkpoint, which is how Composer ends turns without turn_ended.
  // Field 7 (partial_tool_call) streams the lookup's call before
  // tool_call_started, so both are dropped.
  for (const hex of composerDynamicToolsPacket1) {
    const payload = Buffer.from(hex, "hex");
    if (
      decodeAgentServerMessage(payload).some(
        (d) => d.kind === "tool_call_started" || (d.kind === "unknown" && d.field === 7)
      )
    )
      continue;
    processFrame(payload, ctx, acked, { mcpTools: readFileTools });
  }
  assert.equal(ctx.endReason, "kv_after_text");
  assert.equal(ctx.toolCalls.length, 0);
});
