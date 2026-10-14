#!/usr/bin/env node
// Decode a raw Cursor h2 agent-stream dump (bytes appended by streamDriver.ts
// onData when CURSOR_DEBUG=1 + CURSOR_DUMP_FILE are set) into a frame-by-frame
// timeline, using OmniRoute's own protobuf decoders.
//
// Usage:
//   node decode-dump.mjs <dump-file> [--executors-dir <open-sse parent>] [--out <json>]
//
// The dump is a byte stream of Connect-RPC frames: 1 flag byte + 4-byte BE
// length + payload (optionally gzipped when flag & 0x1). Requests (client ->
// server) and responses (server -> client) are interleaved; the flag byte
// cannot distinguish them, so we classify by content: frames that decode as
// AgentServerMessage payloads (interaction_update / exec_server_message /
// kv_server_message) vs RunRequest-style frames (agent handshake).
//
// Output: JSON array of frames: { i, off, flag, len, gzip, msSincePrev,
// msSinceStart, classification, decoded } where decoded is either the
// DecodedDelta[] / ExecServerEvent / KvServerEvent from the repo decoders or a
// raw field map for unknown shapes.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const dumpPath = args.shift();
const executorsDir =
  args.indexOf("--executors-dir") >= 0 ? args[args.indexOf("--executors-dir") + 1] : null;
const outPath = args.indexOf("--out") >= 0 ? args[args.indexOf("--out") + 1] : null;

if (!dumpPath) {
  console.error("usage: decode-dump.mjs <dump-file> [--executors-dir <dir>] [--out <json>]");
  process.exit(2);
}

const base = executorsDir || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "open-sse");
const pbUrl = pathToFileURL(join(base, "utils", "cursorAgentProtobuf.ts")).href;

const pb = await import(pbUrl);

const buf = readFileSync(dumpPath);

// ── minimal protobuf field walker (mirrors wire.ts) ──
function decodeFields(payload) {
  const out = [];
  let pos = 0;
  while (pos < payload.length) {
    const tagStart = pos;
    let tag = 0n;
    let shift = 0n;
    while (true) {
      if (pos >= payload.length) return out; // truncated
      const b = payload[pos++];
      tag |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 0) return out;
    if (wireType === 0) {
      let v = 0n;
      let s = 0n;
      while (true) {
        if (pos >= payload.length) return out;
        const b = payload[pos++];
        v |= BigInt(b & 0x7f) << s;
        if ((b & 0x80) === 0) break;
        s += 7n;
      }
      out.push({ fieldNumber, wireType, varint: v });
    } else if (wireType === 2) {
      let l = 0n;
      let s = 0n;
      while (true) {
        if (pos >= payload.length) return out;
        const b = payload[pos++];
        l |= BigInt(b & 0x7f) << s;
        if ((b & 0x80) === 0) break;
        s += 7n;
      }
      const len = Number(l);
      if (len < 0 || pos + len > payload.length) return out;
      out.push({ fieldNumber, wireType, bytes: payload.subarray(pos, pos + len) });
      pos += len;
    } else if (wireType === 5) {
      out.push({ fieldNumber, wireType, fixed32: payload.readUInt32LE(pos) });
      pos += 4;
    } else if (wireType === 1) {
      out.push({ fieldNumber, wireType, fixed64: payload.readBigUInt64LE(pos) });
      pos += 8;
    } else {
      return out; // groups unsupported
    }
    void tagStart;
  }
  return out;
}

function previewBytes(bytes, max = 120) {
  const text = bytes.toString("utf8");
  // printable-ish preview, escaping newlines
  const clean = text.replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7e]/g, ".");
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

// Classify a decompressed payload by top-level shape.
function classify(payload) {
  const fields = decodeFields(payload);
  const top = fields.map((f) => f.fieldNumber);
  const has = (n) => top.includes(n);
  const ASM_INTERACTION_UPDATE = 1;
  const ASM_EXEC_SERVER_MESSAGE = 2;
  const ASM_KV_SERVER_MESSAGE = 4;

  // response shapes
  if (has(ASM_INTERACTION_UPDATE) || has(ASM_EXEC_SERVER_MESSAGE) || has(ASM_KV_SERVER_MESSAGE)) {
    let kind = "server:";
    if (has(ASM_INTERACTION_UPDATE)) kind += "interaction_update";
    if (has(ASM_EXEC_SERVER_MESSAGE)) kind += "+exec";
    if (has(ASM_KV_SERVER_MESSAGE)) kind += "+kv";
    return { role: "server", kind };
  }

  // JSON end-of-stream frames
  if (payload[0] === 0x7b || payload[0] === 0x7d) {
    return { role: "eos", kind: "json", text: payload.toString("utf8").slice(0, 300) };
  }

  return { role: "unknown", kind: "fields:" + top.join(",") };
}

function decodeServerFrame(payload) {
  const out = { deltas: [], exec: null, kv: null, unknownFields: [] };
  try {
    out.deltas = pb.decodeAgentServerMessage(payload);
  } catch (e) {
    out.deltas = [{ kind: "decode_error", error: String(e) }];
  }
  try {
    out.exec = pb.decodeExecServerEvent(payload);
  } catch {
    out.exec = null;
  }
  try {
    out.kv = pb.decodeKvServerEvent(payload);
  } catch {
    out.kv = null;
  }
  return out;
}

const frames = [];
let pos = 0;
let i = 0;
let t0 = null;
let tPrev = null;

while (pos + 5 <= buf.length) {
  const flag = buf[pos];
  const len = buf.readUInt32BE(pos + 1);
  const off = pos;
  if (pos + 5 + len > buf.length) {
    frames.push({ i, off, flag, len, truncated: true, remaining: buf.length - pos });
    break;
  }
  const raw = buf.subarray(pos + 5, pos + 5 + len);
  const gzip = (flag & 0x1) !== 0;
  const endStream = (flag & 0x2) !== 0;
  let payload = raw;
  let gunzipError = null;
  if (gzip) {
    try {
      payload = gunzipSync(raw);
    } catch (e) {
      gunzipError = String(e);
    }
  }
  const now = Date.now();
  if (t0 === null) t0 = now;
  const cls = gunzipError ? { role: "error", kind: "gunzip:" + gunzipError } : classify(payload);

  const frame = {
    i,
    off,
    flag,
    flagBits: `0x${flag.toString(16).padStart(2, "0")}`,
    len,
    payloadLen: payload.length,
    gzip,
    endStream,
    cls: cls.kind,
  };

  if (cls.role === "server") {
    const dec = decodeServerFrame(payload);
    frame.deltas = dec.deltas;
    frame.exec = dec.exec;
    frame.kv = dec.kv
      ? {
          kind: dec.kv.kind,
          kvId: dec.kv.kvId,
          blobIdHex: dec.kv.blobId ? Buffer.from(dec.kv.blobId).toString("hex").slice(0, 16) : null,
          blobDataLen: dec.kv.blobData ? dec.kv.blobData.length : 0,
        }
      : null;
    if (dec.kv?.kind === "kv_set_blob" && dec.kv.blobData) {
      frame.kvBlobPreview = previewBytes(dec.kv.blobData, 200);
    }
  } else if (cls.role === "unknown") {
    frame.fields = decodeFields(payload)
      .slice(0, 12)
      .map((f) => ({
        n: f.fieldNumber,
        wt: f.wireType,
        len: f.bytes ? f.bytes.length : undefined,
        varint: f.varint !== undefined ? f.varint.toString() : undefined,
        preview: f.bytes ? previewBytes(f.bytes) : undefined,
      }));
  } else if (cls.role === "eos") {
    frame.eos = cls.text;
  }

  frames.push(frame);
  pos += 5 + len;
  i++;
  tPrev = now;
}

void tPrev;

const summary = {
  dump: dumpPath,
  bytes: buf.length,
  frames: frames.length,
  counts: {},
};
for (const f of frames) {
  summary.counts[f.cls] = (summary.counts[f.cls] || 0) + 1;
}

const result = { summary, frames };
const json = JSON.stringify(result, null, 1);
if (outPath) writeFileSync(outPath, json);

// human timeline to stdout
console.log(JSON.stringify(summary, null, 1));
for (const f of frames) {
  const parts = [`#${f.i}`, `off=${f.off}`, `flag=${f.flagBits}`, `len=${f.len}`, f.cls];
  if (f.gzip) parts.push("gzip");
  if (f.endStream) parts.push("END_STREAM");
  if (f.deltas) {
    const d = f.deltas
      .map((delta) => {
        if (delta.kind === "text") return `text(${JSON.stringify(delta.text.slice(0, 80))})`;
        if (delta.kind === "thinking")
          return `thinking(${JSON.stringify(delta.text.slice(0, 80))})`;
        if (delta.kind === "turn_ended") return `turn_ended(${JSON.stringify(delta.usage ?? {})})`;
        if (delta.kind === "token_delta") return `token(+${delta.tokens})`;
        return delta.kind + (delta.field !== undefined ? `(${delta.field})` : "");
      })
      .join(" ");
    parts.push("[" + d + "]");
  }
  if (f.exec && f.exec.kind) {
    const { kind, execMsgId, execId, ...rest } = f.exec;
    parts.push(
      `EXEC ${kind} id=${execMsgId} execId=${JSON.stringify(execId)} ${JSON.stringify(rest).slice(0, 160)}`
    );
  }
  if (f.kv)
    parts.push(
      `KV ${f.kv.kind} id=${f.kv.kvId} blob=${f.kv.blobIdHex} dataLen=${f.kv.blobDataLen}`
    );
  if (f.kvBlobPreview) parts.push(`kvBlob=${JSON.stringify(f.kvBlobPreview)}`);
  if (f.eos) parts.push(`eos=${JSON.stringify(f.eos)}`);
  if (f.fields) parts.push("fields=" + JSON.stringify(f.fields));
  console.log(parts.join(" "));
}
