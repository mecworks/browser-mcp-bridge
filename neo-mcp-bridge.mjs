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
//
// PROTOCOL: MCP over streamable HTTP (protocol version 2025-06-18).
//           The initialize response carries an `mcp-session-id` header that
//           must be echoed on every later request; SSE-wrapped responses
//           are unwrapped to the final `message` event. If neo is restarted,
//           the session goes stale and the bridge re-initializes once before
//           retrying (one retry per request; beyond that, error out).

const NEO_URL = process.env.BROWSEROS_MCP_URL || "http://127.0.0.1:9210/mcp";
const PROTOCOL_VERSION = "2025-06-18";

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
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const text = await res.text();
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
    clientInfo: { name: "neo-mcp-bridge", version: "1.0.0" },
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

rl.on("line", async (line) => {
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
          serverInfo: { name: "BrowserOS neo (stdio bridge)", version: "1.0.0" },
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
});

rl.on("close", () => process.exit(0));

log(`neo-mcp-bridge on stdio -> ${NEO_URL} (zero-dep, Node >= 18)`);
