// Copyright (C) 2026 Marc Christensen <mecworks@gmail.com>
//
// bridge-test.mjs — spawns neo-mcp-bridge as a child (like Chatbox would)
// and runs initialize -> tools/list -> tools/call(tabs) over stdio.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(dir, "neo-mcp-bridge.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

let buf = "";
const pending = new Map();
function onLine(line) {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
}
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    onLine(l);
  }
});

function call(id, method, params) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for id ${id}`)), 30000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const t0 = Date.now();
try {
  const init = await call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bridge-test", version: "1.0.0" },
  });
  console.log(`initialize (${Date.now() - t0} ms):`, JSON.stringify(init.result?.serverInfo), "protocol", init.result?.protocolVersion);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await call(2, "tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  console.log(`tools/list: ${names.length} tools ->`, names.join(", "));

  const tabs = await call(3, "tools/call", { name: "tabs", arguments: {} });
  const txt = JSON.stringify(tabs.result ?? tabs);
  console.log(`tools/call(tabs): ${txt.length} chars, isError=${tabs.result?.isError ?? "n/a"}`);
  console.log("  sample:", txt.slice(0, 300));

  console.log("\nALL PASSED");
} catch (e) {
  console.error("FAILED:", e.message);
  console.error("--- stderr ---\n" + stderr);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 2000);
}
