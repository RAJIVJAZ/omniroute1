#!/usr/bin/env node
// Print per-frame server timestamps from a Cursor dump. Interaction updates
// carry a millisecond server clock in InteractionUpdate field 25; tool-call
// bodies also carry it in field 59. Frames without one inherit the last seen
// value (marked "~"). Request boundaries are the exec_request_context frames.
// Usage: node frame-times.mjs <dump>
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const buf = readFileSync(process.argv[2]);

function varint(b, p) {
  let v = 0n;
  let s = 0n;
  for (;;) {
    if (p >= b.length) return null;
    const x = b[p++];
    v |= BigInt(x & 0x7f) << s;
    if ((x & 0x80) === 0) return [v, p];
    s += 7n;
  }
}
function fields(b) {
  const out = [];
  let p = 0;
  while (p < b.length) {
    const t = varint(b, p);
    if (!t) return [];
    const n = Number(t[0] >> 3n);
    const wt = Number(t[0] & 7n);
    p = t[1];
    if (wt === 0) {
      const v = varint(b, p);
      if (!v) return [];
      out.push({ n, wt, v: v[0] });
      p = v[1];
    } else if (wt === 2) {
      const l = varint(b, p);
      if (!l) return [];
      const len = Number(l[0]);
      p = l[1];
      if (p + len > b.length) return [];
      out.push({ n, wt, b: b.subarray(p, p + len) });
      p += len;
    } else if (wt === 1) {
      p += 8;
    } else if (wt === 5) {
      p += 4;
    } else return [];
  }
  return out;
}

const iuNames = {
  1: "text",
  2: "tool_call_started",
  3: "tool_call_completed",
  4: "thinking",
  5: "thinking_complete",
  7: "partial_tool_call?",
  8: "token_delta",
  13: "heartbeat",
  14: "turn_ended",
  27: "field27",
};

let pos = 0;
let i = 0;
let last = null;
let req = 0;
while (pos + 5 <= buf.length) {
  const flag = buf[pos];
  const len = buf.readUInt32BE(pos + 1);
  if (pos + 5 + len > buf.length) break;
  const raw = buf.subarray(pos + 5, pos + 5 + len);
  const payload = flag & 1 ? gunzipSync(raw) : raw;
  const top = fields(payload);
  let ts = null;
  const kinds = [];
  for (const f of top) {
    if (f.n === 1 && f.wt === 2) {
      for (const u of fields(f.b)) {
        if (u.n === 25 && u.wt === 0) ts = Number(u.v);
        else kinds.push(iuNames[u.n] ?? `iu${u.n}`);
      }
    } else if (f.n === 2 && f.wt === 2) {
      const ex = fields(f.b);
      const variant = ex.find((x) => x.wt === 2 && ![15, 19, 57].includes(x.n));
      if (variant?.n === 10) req++;
      kinds.push(`exec(field ${variant?.n})`);
    } else if (f.n === 4) kinds.push("kv");
    else kinds.push(`asm${f.n}`);
  }
  if (ts !== null) last = ts;
  const shown =
    ts !== null
      ? new Date(ts).toISOString().slice(11, 23)
      : last
        ? "~" + new Date(last).toISOString().slice(11, 23)
        : "-";
  console.log(`req${req} #${i}\t${shown}\t${kinds.join(",")}`);
  pos += 5 + len;
  i++;
}
