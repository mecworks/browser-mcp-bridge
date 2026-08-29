// Copyright (C) 2026 Marc Christensen <mecworks@gmail.com>
//
// bridge-test.mjs — self-test for neo-mcp-bridge.
//
// Version: 1.1.0 (matches neo-mcp-bridge.mjs)
//
// Two suites:
//   MOCK — hermetic robustness/security tests. The bridge is spawned
//          exactly like a client would and driven against scripted mock
//          upstreams; the neo server is NOT required. Covers the v1.1.0
//          hardening:
//            T1  upstream request timeout        (M1, BROWSEROS_BRIDGE_TIMEOUT_MS)
//            T2  upstream response size cap      (M2, BROWSEROS_BRIDGE_MAX_RESPONSE_MB)
//            T3  redirect handling (never follow)(F4)
//            T4  stdin serialization             (F5)
//            T5  URL validation + remote warning (F3, BROWSEROS_BRIDGE_ALLOW_REMOTE)
//            T7  stale-session re-init regression
//   LIVE — end-to-end against a real neo server (initialize -> tools/list
//          -> tools/call(tabs)). If neo is not reachable the live suite is
//          skipped with a notice (a skip is not a failure).
//
// Usage:
//   node bridge-test.mjs               both suites (default, ~20 s)
//   node bridge-test.mjs --mock-only   mock suite only (neo not needed)
//   node bridge-test.mjs --live-only   live suite only (neo required)
//
// Exit code 0 when every check passes; 1 on any failure.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(dir, "neo-mcp-bridge.mjs");

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock upstream helpers ---------------------------------------------------
function sseBody(id, result) {
  return `data:\nid: 0\nretry: 3000\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
}
const INIT_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "mock-neo", version: "0.0.1" },
};
const TOOLS_RESULT = {
  tools: [{ name: "mocktool", description: "mock", inputSchema: { type: "object" } }],
};
function ok(res, body, session) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "mcp-session-id": session,
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}
function bigSse(id, mb) {
  const pad = "A".repeat(Math.floor(mb * 1024 * 1024) - 300);
  return sseBody(id, { pad });
}

// A minimal HTTP server that acts as a fake neo: the handler decides the
// response per request; every request is logged with its headers and the
// t0/t1 receive/finish timestamps.
function mockServer(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const entry = { t0: Date.now(), headers: { ...req.headers }, body };
      requests.push(entry);
      Promise.resolve(handler(req, res, body, entry))
        .then(() => { entry.t1 = Date.now(); })
        .catch(() => {
          if (!res.headersSent) { try { res.writeHead(500); } catch {} }
          try { res.end("mock error"); } catch {}
        });
    });
  });
  srv.on("clientError", () => {});
  srv.requests = requests;
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}
// ---- bridge runner (spawns the bridge exactly like a client would) ----------
function runBridge(env = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  return {
    child,
    send(o) { child.stdin.write(JSON.stringify(o) + "\n"); },
    waitReply(id, ms = 15000) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          for (const l of out.split("\n")) {
            if (!l.trim()) continue;
            try {
              const m = JSON.parse(l);
              if (m.id === id) { clearInterval(timer); resolve({ msg: m, ms: Date.now() - t0 }); return; }
            } catch {}
          }
          if (Date.now() - t0 > ms) {
            clearInterval(timer);
            reject(new Error(`no reply id=${id} within ${ms} ms; stderr: ${err}`));
          }
        }, 20);
      });
    },
    waitStderr(substr, ms = 3000) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const t = setInterval(() => {
          if (err.includes(substr)) { clearInterval(t); resolve(true); }
          else if (Date.now() - t0 > ms) { clearInterval(t); resolve(false); }
        }, 20);
      });
    },
    stderr: () => err,
    exitCode(ms = 5000) {
      return new Promise((r) => {
        let code = null;
        const t = setTimeout(() => r(code), ms);
        child.on("exit", (c) => { clearTimeout(t); r(c); });
      });
    },
    async stop() {
      try { child.stdin.end(); } catch {}
      // If the bridge already exited (e.g. F3 fail-fast), 'close' can never
      // fire with stdin still open — kill instead.
      if (child.exitCode !== null || child.killed) { child.kill(); return; }
      const t = setTimeout(() => child.kill(), 2000);
      await new Promise((r) => child.on("close", () => { clearTimeout(t); r(); }));
    },
  };
}
function initReq(id, name) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1.1.0" } },
  };
}
const toolsListReq = (id) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });
// ---- T1: M1 upstream request timeout ----------------------------------------
async function suiteTimeout() {
  console.log("\n=== T1  M1: upstream request timeout ===");
  let slowDone = false;
  const { srv, port } = await mockServer(async (req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize" && !slowDone) { slowDone = true; await sleep(4000); }
    ok(res, sseBody(m.id, m.method === "initialize" ? INIT_RESULT : TOOLS_RESULT), "sess-m1");
  });
  const b = runBridge({
    BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    BROWSEROS_BRIDGE_TIMEOUT_MS: "1500",
  });
  check("T1a startup log shows effective timeout '1500 ms'",
    await b.waitStderr("timeout 1500 ms", 3000), b.stderr());
  b.send(initReq(1, "bridge-test"));
  const { msg, ms } = await b.waitReply(1, 10000);
  check("T1b timed-out request returns a JSON-RPC error", !!msg.error, JSON.stringify(msg).slice(0, 200));
  check("T1c error message mentions abort/timeout", /abort|timeout|timed/i.test(msg?.error?.message || ""), msg?.error?.message);
  check("T1d failed fast (~1.5 s), not 4 s", ms < 3500, `elapsed ${ms} ms`);
  b.send(toolsListReq(2));
  const r2 = await b.waitReply(2);
  check("T1e bridge alive after timeout: tools/list succeeds",
    r2.msg?.result?.tools?.length === 1, JSON.stringify(r2.msg).slice(0, 200));
  await b.stop(); srv.close();

  console.log("\n=== T1b  M1: timeout disabled with 0 ===");
  let once = true;
  const m2 = await mockServer(async (req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize" && once) { once = false; await sleep(1500); }
    ok(res, sseBody(m.id, m.method === "initialize" ? INIT_RESULT : TOOLS_RESULT), "sess-m1b");
  });
  const b2 = runBridge({
    BROWSEROS_MCP_URL: `http://127.0.0.1:${m2.port}/mcp`,
    BROWSEROS_BRIDGE_TIMEOUT_MS: "0",
  });
  check("T1b-1 startup log shows 'timeout none'", await b2.waitStderr("timeout none", 3000), b2.stderr());
  b2.send(initReq(1, "bridge-test"));
  const i = await b2.waitReply(1, 10000);
  check("T1b-2 1.5 s upstream delay survives with timeout off",
    !!i.msg?.result?.serverInfo && i.ms >= 1400,
    `elapsed ${i.ms} ms: ${JSON.stringify(i.msg).slice(0, 120)}`);
  await b2.stop(); m2.srv.close();
}
// ---- T2: M2 response size cap -------------------------------------------------
async function suiteSizeCap() {
  console.log("\n=== T2  M2: response size cap ===");
  // T2a: default cap (10 MiB), Content-Length present -> pre-check rejects
  let { srv, port } = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") ok(res, sseBody(0, INIT_RESULT), "s2");
    else if (m.id === 2) ok(res, bigSse(2, 11), "s2");
    else ok(res, sseBody(m.id, TOOLS_RESULT), "s2");
  });
  let b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp` });
  check("T2a-1 startup log shows default cap '10 MiB'", await b.waitStderr("response cap 10 MiB", 3000), b.stderr());
  b.send(initReq(1, "bridge-test"));
  await b.waitReply(1);
  b.send(toolsListReq(2));
  const r2 = await b.waitReply(2);
  check("T2a-2 11 MiB response rejected with 'too large' error",
    /too large/i.test(r2.msg?.error?.message || ""), r2.msg?.error?.message);
  b.send(toolsListReq(3));
  const r3 = await b.waitReply(3);
  check("T2a-3 bridge alive after rejection: next request succeeds",
    r3.msg?.result?.tools?.length === 1, JSON.stringify(r3.msg).slice(0, 150));
  await b.stop(); srv.close();

  // T2b: env override raises cap to 20 MiB -> 11 MiB passes
  ({ srv, port } = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") ok(res, sseBody(0, INIT_RESULT), "s2");
    else ok(res, bigSse(m.id, 11), "s2");
  }));
  b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp`, BROWSEROS_BRIDGE_MAX_RESPONSE_MB: "20" });
  check("T2b-1 startup log shows overridden cap '20 MiB'", await b.waitStderr("response cap 20 MiB", 3000), b.stderr());
  b.send(initReq(1, "bridge-test"));
  await b.waitReply(1);
  b.send(toolsListReq(2));
  const r4 = await b.waitReply(2, 20000);
  check("T2b-2 11 MiB response passes with raised cap",
    (r4.msg?.result?.pad?.length ?? 0) > 10 * 1024 * 1024, `pad length ${r4.msg?.result?.pad?.length}`);
  await b.stop(); srv.close();

  // T2c: chunked (no Content-Length) 11 MiB -> chunked cap rejects
  ({ srv, port } = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") { ok(res, sseBody(0, INIT_RESULT), "s2"); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s2" }); // no content-length
    const chunk = "A".repeat(512 * 1024);
    const total = 11 * 1024 * 1024;
    let sent = 0;
    const step = () => {
      let w;
      while (sent < total && (w = res.write(chunk))) sent += chunk.length;
      if (sent >= total) res.end(); else res.once("drain", step);
    };
    step();
  }));
  b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp` });
  b.send(initReq(1, "bridge-test"));
  await b.waitReply(1);
  b.send(toolsListReq(2));
  const r5 = await b.waitReply(2, 20000);
  check("T2c-1 chunked 11 MiB (no Content-Length) rejected mid-stream",
    /too large/i.test(r5.msg?.error?.message || ""), r5.msg?.error?.message);
  await b.stop(); srv.close();

  // T2d: env override lowers cap to 0.5 MiB -> 1 MiB rejected
  ({ srv, port } = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") ok(res, sseBody(0, INIT_RESULT), "s2");
    else ok(res, bigSse(m.id, 1), "s2");
  }));
  b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp`, BROWSEROS_BRIDGE_MAX_RESPONSE_MB: "0.5" });
  check("T2d-1 startup log shows lowered cap '0.5 MiB'", await b.waitStderr("response cap 0.5 MiB", 3000), b.stderr());
  b.send(initReq(1, "bridge-test"));
  await b.waitReply(1);
  b.send(toolsListReq(2));
  const r6 = await b.waitReply(2);
  check("T2d-2 1 MiB response rejected with lowered 0.5 MiB cap",
    /too large/i.test(r6.msg?.error?.message || ""), r6.msg?.error?.message);
  await b.stop(); srv.close();

  // T2e: env override 0 disables the limit entirely
  ({ srv, port } = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") ok(res, sseBody(0, INIT_RESULT), "s2");
    else ok(res, bigSse(m.id, 11), "s2");
  }));
  b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp`, BROWSEROS_BRIDGE_MAX_RESPONSE_MB: "0" });
  check("T2e-1 startup log shows 'response cap none'", await b.waitStderr("response cap none", 3000), b.stderr());
  b.send(initReq(1, "bridge-test"));
  await b.waitReply(1);
  b.send(toolsListReq(2));
  const r7 = await b.waitReply(2, 20000);
  check("T2e-2 11 MiB response passes with limit disabled (0)",
    (r7.msg?.result?.pad?.length ?? 0) > 10 * 1024 * 1024, `pad length ${r7.msg?.result?.pad?.length}`);
  await b.stop(); srv.close();
}
// ---- T3: F4 redirect:manual --------------------------------------------------
async function suiteRedirect() {
  console.log("\n=== T3  F4: redirect handling ===");
  const hijack = await mockServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseBody(2, TOOLS_RESULT));
  });
  const main = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") { ok(res, sseBody(0, INIT_RESULT), "sess-secret-xyz"); return; }
    res.writeHead(302, { location: `http://127.0.0.1:${hijack.port}/hijack` });
    res.end();
  });
  const b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${main.port}/mcp` });
  b.send(initReq(1, "bridge-test"));
  await b.waitReply(1);
  b.send(toolsListReq(2));
  const r = await b.waitReply(2);
  check("T3a 302 returned to client as an error (not followed)",
    /302/.test(r.msg?.error?.message || ""), r.msg?.error?.message);
  await sleep(400); // give a (non-existent) redirect time to arrive
  check("T3b redirect target received ZERO requests (session header never left)",
    hijack.srv.requests.length === 0, `hijack saw ${hijack.srv.requests.length} request(s)`);
  const sawSession = main.srv.requests.some((q) => q.headers["mcp-session-id"] === "sess-secret-xyz");
  check("T3c session id still echoed to the (legitimate) main upstream", sawSession,
    `requests=${main.srv.requests.length}`);
  await b.stop(); main.srv.close(); hijack.srv.close();
}

// ---- T4: F5 stdin serialization -----------------------------------------------
async function suiteSerialization() {
  console.log("\n=== T4  F5: stdin serialization ===");
  const { srv, port } = await mockServer(async (req, res, body) => {
    const m = JSON.parse(body);
    await sleep(300);
    ok(res, sseBody(m.id, m.method === "initialize" ? INIT_RESULT : TOOLS_RESULT), "sess-f5");
  });
  const b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp` });
  b.send(initReq(1, "bridge-test"));
  const i = await b.waitReply(1);
  check("T4a initialize ok", !!i.msg?.result?.serverInfo);
  // Two overlapping requests, written back-to-back in the same tick:
  b.send(toolsListReq(2));
  b.send(toolsListReq(3));
  const [r2, r3] = await Promise.all([b.waitReply(2), b.waitReply(3)]);
  check("T4b both overlapping replies delivered",
    r2.msg?.result?.tools?.length === 1 && r3.msg?.result?.tools?.length === 1,
    JSON.stringify({ r2: r2.msg, r3: r3.msg }).slice(0, 200));
  const q = srv.requests; // [init, req2, req3]
  const gap = q[2].t0 - q[1].t1; // when req3 started vs when req2 finished
  check("T4c strictly serialized: req3 started only after req2 finished",
    gap >= -5, `req3.t0 - req2.t1 = ${gap} ms (>= -5 expected)`);
  const spread = q[2].t0 - q[1].t0;
  check("T4d requests ~300 ms apart (not concurrent)", spread >= 290, `delta ${spread} ms`);
  await b.stop(); srv.close();
}
// ---- T5: F3 URL validation + remote warning -----------------------------------
async function suiteUrlValidation() {
  console.log("\n=== T5  F3: URL validation + remote warning ===");
  {
    const b = runBridge({ BROWSEROS_MCP_URL: "http://10.66.0.1:9210/mcp" });
    const warned = await b.waitStderr("WARNING: upstream host '10.66.0.1' is not localhost", 3000);
    check("T5a non-localhost host -> startup warning", warned, b.stderr());
    check("T5b warning mentions the suppression flag",
      b.stderr().includes("BROWSEROS_BRIDGE_ALLOW_REMOTE=1"), b.stderr());
    await b.stop();
  }
  {
    const b = runBridge({ BROWSEROS_MCP_URL: "http://10.66.0.1:9210/mcp", BROWSEROS_BRIDGE_ALLOW_REMOTE: "1" });
    const warned = await b.waitStderr("WARNING: upstream host", 1500);
    check("T5c ALLOW_REMOTE=1 -> no warning", !warned, b.stderr());
    await b.stop();
  }
  {
    const { srv, port } = await mockServer((req, res, body) => {
      const m = JSON.parse(body);
      ok(res, sseBody(m.id, m.method === "initialize" ? INIT_RESULT : TOOLS_RESULT), "s5");
    });
    const b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp` });
    const warned = await b.waitStderr("WARNING: upstream host", 1500);
    check("T5d loopback host -> no warning", !warned, b.stderr());
    await b.stop(); srv.close();
  }
  {
    const b = runBridge({ BROWSEROS_MCP_URL: "not-a-url" });
    const code = await b.exitCode(5000);
    check("T5e invalid URL -> exit code 1 with clear error",
      code === 1 && /not a valid URL/.test(b.stderr()), `code=${code} stderr=${b.stderr()}`);
    await b.stop();
  }
  {
    const b = runBridge({ BROWSEROS_MCP_URL: "ftp://127.0.0.1:9210/mcp" });
    const code = await b.exitCode(5000);
    check("T5f non-http(s) scheme -> exit code 1 with clear error",
      code === 1 && /must be http\(s\)/.test(b.stderr()), `code=${code} stderr=${b.stderr()}`);
    await b.stop();
  }
}

// ---- T7: stale-session re-init regression --------------------------------------
async function suiteReinit() {
  console.log("\n=== T7  regression: stale-session re-init + one retry ===");
  let initCount = 0;
  let phase = 0;
  const { srv, port } = await mockServer((req, res, body) => {
    const m = JSON.parse(body);
    if (m.method === "initialize") { initCount++; ok(res, sseBody(0, INIT_RESULT), `sess-${initCount}`); return; }
    if (phase === 0) {
      phase = 1;
      const e = JSON.stringify({ error: "session invalid: unknown session id" });
      res.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(e)) });
      res.end(e);
      return;
    }
    ok(res, sseBody(m.id, TOOLS_RESULT), `sess-${initCount}`);
  });
  const b = runBridge({ BROWSEROS_MCP_URL: `http://127.0.0.1:${port}/mcp` });
  b.send(initReq(1, "bridge-test"));
  const i = await b.waitReply(1);
  check("T7a initialize ok", !!i.msg?.result?.serverInfo);
  b.send(toolsListReq(2));
  const r = await b.waitReply(2);
  check("T7b request retried after transparent re-init and succeeded",
    r.msg?.result?.tools?.length === 1, JSON.stringify(r.msg).slice(0, 200));
  const sawLog = await b.waitStderr("re-initializing once", 1500);
  check("T7c re-init logged once", sawLog, b.stderr());
  check("T7d exactly two upstream initializations (original + one retry)",
    initCount === 2, `initCount=${initCount}`);
  await b.stop(); srv.close();
}
// ---- LIVE: end-to-end against a real neo server --------------------------------
let liveSkipped = null; // reason string when the live suite is skipped
async function suiteLive() {
  const url = process.env.BROWSEROS_MCP_URL || "http://127.0.0.1:9210/mcp";
  console.log(`\n=== LIVE  end-to-end against the real neo server (${url}) ===`);
  const b = runBridge({});
  const t0 = Date.now();
  b.send(initReq(1, "bridge-test"));
  let init;
  try {
    init = await b.waitReply(1, 15000);
  } catch (e) {
    liveSkipped = `bridge did not answer within 15 s (${e.message.split("\n")[0]})`;
    console.log(`SKIP  live suite: ${liveSkipped}`);
    await b.stop();
    return;
  }
  if (init.msg?.error) {
    const m = init.msg.error.message || "";
    if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(m)) {
      liveSkipped = `neo not reachable at ${url}`;
      console.log(`SKIP  live suite: ${liveSkipped} — start the neo app and re-run (or use --mock-only)`);
      await b.stop();
      return;
    }
    check("L1 initialize ok", false, m);
    await b.stop();
    return;
  }
  check("L1 initialize ok", !!init.msg?.result?.serverInfo, JSON.stringify(init.msg.result).slice(0, 200));
  console.log(`    initialize (${Date.now() - t0} ms): ${JSON.stringify(init.msg.result.serverInfo)}, protocol ${init.msg.result.protocolVersion}`);
  b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  b.send(toolsListReq(2));
  const tools = await b.waitReply(2);
  const names = tools.msg?.result?.tools?.map((t) => t.name) || [];
  check("L2 tools/list returns tools", names.length > 0, `${names.length} tools`);
  console.log(`    tools/list: ${names.length} tools -> ${names.join(", ")}`);
  b.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tabs", arguments: {} } });
  const tabs = await b.waitReply(3);
  const txt = JSON.stringify(tabs.msg?.result ?? tabs.msg);
  check("L3 tools/call(tabs) round-trip", tabs.msg?.result !== undefined, txt.slice(0, 200));
  console.log(`    tools/call(tabs): ${txt.length} chars, isError=${tabs.msg?.result?.isError ?? "n/a"}`);
  console.log(`    sample: ${txt.slice(0, 300)}`);
  await b.stop();
}

// ---- runner ---------------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const wantMock = !args.has("--live-only");
const wantLive = !args.has("--mock-only");

console.log(`bridge-test v1.1.0 — self-test for neo-mcp-bridge.mjs (suites: ${wantMock ? "mock" : "-"} ${wantLive ? "live" : "-"})`);

try {
  if (wantMock) {
    await suiteTimeout();
    await suiteSizeCap();
    await suiteRedirect();
    await suiteSerialization();
    await suiteUrlValidation();
    await suiteReinit();
  }
  if (wantLive) await suiteLive();
} catch (e) {
  check("harness crashed", false, e.stack || String(e));
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n================ SUMMARY: ${passed}/${results.length} checks passed ================`);
for (const r of results) if (!r.pass) console.log(`  FAIL  ${r.name}`);
if (wantLive && liveSkipped) console.log(`  (live suite skipped: ${liveSkipped})`);
if (passed === results.length) {
  console.log(wantLive && liveSkipped ? "PASSED (live suite skipped — start neo for the full check)" : "ALL PASSED");
}
process.exit(passed === results.length ? 0 : 1);