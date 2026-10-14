#!/usr/bin/env node
// Print the raw protobuf tree of selected frames from a Cursor dump, to name
// the interaction-update fields OmniRoute leaves "unknown" (7, 25, 27), the
// tool_call_started / tool_call_completed bodies, and AgentServerMessage
// field 3. Usage: node dump-fields.mjs <dump> <frameIndex>[,<frameIndex>...]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const [dumpPath, indexArg] = process.argv.slice(2);
const wanted = new Set(
  String(indexArg ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
);
const buf = readFileSync(dumpPath);

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
    if (!t) return null;
    const [tag, p1] = t;
    const n = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (n === 0) return null;
    p = p1;
    if (wt === 0) {
      const v = varint(b, p);
      if (!v) return null;
      out.push({ n, wt, v: v[0] });
      p = v[1];
    } else if (wt === 2) {
      const l = varint(b, p);
      if (!l) return null;
      const len = Number(l[0]);
      p = l[1];
      if (p + len > b.length) return null;
      out.push({ n, wt, b: b.subarray(p, p + len) });
      p += len;
    } else if (wt === 1) {
      if (p + 8 > b.length) return null;
      out.push({ n, wt, v: b.readBigUInt64LE(p) });
      p += 8;
    } else if (wt === 5) {
      if (p + 4 > b.length) return null;
      out.push({ n, wt, v: BigInt(b.readUInt32LE(p)) });
      p += 4;
    } else return null;
  }
  return out;
}

function printable(b) {
  if (b.length === 0) return false;
  let ok = 0;
  for (const x of b) if ((x >= 0x20 && x < 0x7f) || x === 10 || x === 13 || x === 9) ok++;
  return ok / b.length > 0.9;
}

function dump(b, indent, depth) {
  const fs = depth < 8 ? fields(b) : null;
  if (!fs) {
    const s = printable(b)
      ? JSON.stringify(b.toString("utf8").slice(0, 160))
      : `<${b.length} bytes>`;
    console.log(`${indent}${s}`);
    return;
  }
  for (const f of fs) {
    if (f.wt === 2) {
      const strictText =
        f.b.length > 0 && f.b.every((x) => (x >= 0x20 && x < 0x7f) || x === 10 || x === 9);
      const nested = !strictText && depth < 8 ? fields(f.b) : null;
      if (strictText) {
        console.log(`${indent}${f.n}: ${JSON.stringify(f.b.toString("utf8").slice(0, 200))}`);
      } else if (nested && nested.length > 0) {
        console.log(`${indent}${f.n}: {  (${f.b.length} bytes)`);
        dump(f.b, indent + "  ", depth + 1);
        console.log(`${indent}}`);
      } else if (printable(f.b)) {
        console.log(`${indent}${f.n}: ${JSON.stringify(f.b.toString("utf8").slice(0, 200))}`);
      } else {
        console.log(`${indent}${f.n}: <${f.b.length} bytes>`);
      }
    } else {
      console.log(`${indent}${f.n}: ${f.v}`);
    }
  }
}

let pos = 0;
let i = 0;
while (pos + 5 <= buf.length) {
  const flag = buf[pos];
  const len = buf.readUInt32BE(pos + 1);
  if (pos + 5 + len > buf.length) break;
  if (wanted.has(i)) {
    const raw = buf.subarray(pos + 5, pos + 5 + len);
    const payload = flag & 1 ? gunzipSync(raw) : raw;
    console.log(`── frame #${i} flag=${flag} len=${len}`);
    dump(payload, "  ", 0);
  }
  pos += 5 + len;
  i++;
}
