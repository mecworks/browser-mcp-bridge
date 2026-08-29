#!/usr/bin/env node
// Copyright (C) 2026 Marc Christensen <mecworks@gmail.com>
//
// neo-mcp-bridge.mjs — zero-dependency stdio <-> HTTP bridge for BrowserOS neo MCP.
//
// WHAT: Turns the BrowserOS neo server (browseros-claw-server.exe) into a
//       standard stdio MCP server. Reads JSON-RPC lines on stdin, forwards
//       initialize / tools/list / tools/call over HTTP to neo, writes the
//       JSON-RPC result back to stdout — one JSON message per line.
//
// WHY:  The neo server has an anti-browser guard: any HTTP request carrying
//       `Sec-Fetch-Site` or `Origin` headers is rejected with
//       `403 {"error":"unsupported request"}`. Electron-based apps (Chatbox)
//       attach `Sec-Fetch-Site: same-site` to every fetch(), so their direct
//       HTTP MCP connections die at the guard, before the MCP layer. A
//       plain Node process (this bridge) sends neither header, so the
//       connection passes. Stdio clients (Chatbox, Hermes) talk to THIS
//       process instead of the server, sidestepping the guard entirely.
//
// REQUIREMENTS: Node.js >= 18 (built-in fetch only — no npm install needed).
//               The BrowserOS neo (claw) server running and reachable.
//
// CONFIG:  BROWSEROS_MCP_URL   default http://127.0.0.1:9210/mcp
//          (9010 also works; see README.md — 9210 is the direct port,
//           9010 the local proxy port)
//          BROWSEROS_BRIDGE_TIMEOUT_MS       default 120000 — abort one
//                                            upstream request after this
//                                            many ms (0 = no timeout)
//          BROWSEROS_BRIDGE_MAX_RESPONSE_MB  default 10 — max upstream
//                                            response body size (MiB);
//                                            0 = no limit
//          BROWSEROS_BRIDGE_ALLOW_REMOTE     default unset — set 1/true/yes/on
//                                            to silence the non-localhost
//                                            upstream warning (F3)
//
// PROTOCOL: MCP over streamable HTTP (protocol version 2025-06-18).
//           The initialize response carries an `mcp-session-id` header that
//           must be echoed on every later request; SSE-wrapped responses
//           are unwrapped to the final `message` event. If neo is restarted,
//           the session goes stale and the bridge re-initializes once before
//           retrying (one retry per request; beyond that, error out).

const VERSION = "1.1.0";
const NEO_URL = process.env.BROWSEROS_MCP_URL || "http://127.0.0.1:9210/mcp";
const PROTOCOL_VERSION = "2025-06-18";

// ---- Operational limits (overridable via env vars; see README.md) ----------
// Non-negative number from env, or the default if unset/invalid.
function envNum(name, dflt) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
// M1: a stalled upstream must not wedge the bridge (per-request timeout).
const TIMEOUT_MS = envNum("BROWSEROS_BRIDGE_TIMEOUT_MS", 120_000); // ms, 0 = off
// M2: an oversized upstream response must not exhaust memory (body cap).
// 0 = no limit; an invalid value falls back to the default.
const _maxRespMb = envNum("BROWSEROS_BRIDGE_MAX_RESPONSE_MB", 10);
const MAX_RESPONSE_BYTES = _maxRespMb > 0 ? _maxRespMb * 1024 * 1024 : Infinity;
// F3: remote upstreams are supported; only loopback hosts are exempt from
// the startup warning (BROWSEROS_BRIDGE_ALLOW_REMOTE silences it entirely).
const ALLOW_REMOTE = /^(1|true|yes|on)$/i.test(process.env.BROWSEROS_BRIDGE_ALLOW_REMOTE ?? "");

const neoUrl = (() => {
  try {
    const u = new URL(NEO_URL);
    if (!/^https?:$/.test(u.protocol))
      throw new Error(`BROWSEROS_MCP_URL must be http(s): ${NEO_URL}`);
    return u;
  } catch (e) {
    if (e instanceof TypeError)
      console.error(`[neo-bridge] BROWSEROS_MCP_URL is not a valid URL: ${NEO_URL}`);
    else console.error(`[neo-bridge] ${e.message}`);
    process.exit(1);
  }
})();
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);
if (!LOCAL_HOSTS.has(neoUrl.hostname.toLowerCase()) && !ALLOW_REMOTE) {
  console.warn(
    `[neo-bridge] WARNING: upstream host '${neoUrl.hostname}' is not localhost — ` +
    `remote use is supported; set BROWSEROS_BRIDGE_ALLOW_REMOTE=1 to silence this warning.`
  );
}

let sessionId = null;
let initialized = false;

function log(...a) { console.error("[neo-bridge]", ...a); }

function errObj(e) {
  const msg = e?.message || String(e);
  // Neo's guard answers with an HTTP error body; surface it verbatim.
  return {
    isStale: /session/i.test(msg) && /invalid|unknown|expired|not found|closed|ended/i.test(msg),
    msg,
  };
}

// M2: read the response body with a hard size cap. The Content-Length
// pre-check in rpc() catches the common case; this enforces the cap
// chunk-by-chunk for responses that omit (or lie about) Content-Length.
async function readCapped(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* already aborted */ }
        throw new Error(`neo response too large: exceeds ${MAX_RESPONSE_BYTES} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* lock already released by cancel */ }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** One MCP request over streamable HTTP. Returns {jsonRpc: true, value} or a raw object. */
async function rpc(method, params, id) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(NEO_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    redirect: "manual", // F4: never follow a 3xx — following would send the
    // Mcp-Session-Id header to the redirect target and return the
    // redirect target's response to the client.
    signal: TIMEOUT_MS > 0 ? AbortSignal.timeout(TIMEOUT_MS) : undefined, // M1
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  // M2: reject oversized upstream responses before buffering them.
  const cl = Number(res.headers.get("content-length"));
  if (Number.isFinite(cl) && cl > MAX_RESPONSE_BYTES)
    throw new Error(`neo response too large: ${cl} bytes (cap ${MAX_RESPONSE_BYTES})`);

  const text = await readCapped(res);
  if (!res.ok) {
    const e = new Error(`neo ${res.status}: ${text.slice(0, 300)}`);
    e.stale = /session/i.test(text);
    throw e;
  }

  // SSE stream. Observed neo shape (no "event:" lines at all):
  //   data:            <- empty ping event
  //   id: 0
  //   retry: 3000
  //
  //   data: {"jsonrpc":"2.0","id":1,"result":{...}}
  // The JSON-RPC response is the last non-empty data: line that parses as
  // JSON. (Classic MCP "event: message" streams use the same data: lines,
  // so this handles both.)
  if (/^data:/m.test(text) || /^event:/m.test(text)) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d) continue; // empty ping
      try {
        const p = JSON.parse(d);
        if (p && typeof p === "object" && p.id !== undefined) last = p;
      } catch { /* not a message line */ }
    }
    if (!last) throw new Error("neo SSE contained no JSON-RPC message: " + text.slice(0, 200));
    if (last.error) {
      const e = new Error(`neo json-rpc error: ${JSON.stringify(last.error)}`);
      e.stale = false;
      throw e;
    }
    return last.result !== undefined ? last.result : last;
  }

  const json = JSON.parse(text || "null");
  if (json?.error) {
    const e = new Error(`neo json-rpc error: ${JSON.stringify(json.error)}`);
    e.stale = false;
    throw e;
  }
  return json?.result !== undefined ? json.result : json;
}

/** Ensure a live session; re-initialize once on stale-session errors. */
async function ensureSession() {
  if (initialized && sessionId) return;
  await doInitialize();
}

async function doInitialize() {
  const r = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "neo-mcp-bridge", version: VERSION },
  }, 0);
  if (!r?.serverInfo) throw new Error("neo initialize returned no serverInfo: " + JSON.stringify(r).slice(0, 200));
  initialized = true;
  log(`upstream ${r.serverInfo.name} v${r.serverInfo.version} @ ${NEO_URL} (session ${sessionId ? "active" : "none"})`);
}

function out(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { out({ jsonrpc: "2.0", id, result }); }
function replyErr(id, message) { out({ jsonrpc: "2.0", id, error: { code: -32603, message } }); }

async function withSession(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.stale || /session/i.test(e?.message || "")) {
      log("session stale (neo restarted?) — re-initializing once");
      initialized = false;
      sessionId = null;
      await doInitialize();
      return await fn(); // one retry
    }
    throw e;
  }
}

// ---- stdio side -------------------------------------------------------------
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

// F5: serialize stdin handling so at most one request is in flight at a
// time. The stale-session re-init path resets shared session state and
// assumes exclusive access; MCP clients serialize per connection anyway.
let lineQueue = Promise.resolve();

rl.on("line", (line) => {
  lineQueue = lineQueue
    .then(() => handleLine(line))
    .catch((e) => console.error("[neo-bridge] unhandled error:", e?.message || e));
});

async function handleLine(line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; } // non-JSON-RPC line: stay quiet

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize": {
        const r = await ensureSession();
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "BrowserOS neo (stdio bridge)", version: VERSION },
        });
        log(`client ${params?.clientInfo?.name || "?"} connected`);
        break;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        break; // fire and forget
      case "tools/list":
        reply(id, await withSession(() => rpc("tools/list", {}, id)));
        break;
      case "tools/call":
        reply(id, await withSession(() => rpc("tools/call", params, id)));
        break;
      default:
        if (id !== undefined) replyErr(id, `neo-bridge: unsupported method '${method}'`);
        break;
    }
  } catch (e) {
    log(`error on ${method}: ${e?.message || e}`);
    if (id !== undefined) replyErr(id, String(e?.message || e));
  }
}

rl.on("close", () => process.exit(0));

log(
  `neo-mcp-bridge v${VERSION} on stdio -> ${NEO_URL} ` +
  `(timeout ${TIMEOUT_MS ? TIMEOUT_MS + " ms" : "none"}, ` +
  `response cap ${MAX_RESPONSE_BYTES === Infinity ? "none" : (MAX_RESPONSE_BYTES / 1048576) + " MiB"}, zero-dep, Node >= 18)`
);
