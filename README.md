# neo-mcp-bridge — BrowserOS neo for MCP clients that get blocked

**A single-file, zero-dependency stdio↔HTTP bridge that lets Chatbox, Hermes,
Claude Desktop, or any standard MCP client talk to the BrowserOS neo (claw)
server on your machine.**

---

## Why this exists

### The problem

The BrowserOS neo server (`browseros-claw-server.exe`, a Rust binary) has an
**anti-browser guard** built into it. It rejects any HTTP request carrying a
`Sec-Fetch-Site` or `Origin` header with:

```
403 {"error":"unsupported request"}
```

Why would a server do that? Because those two headers are the fingerprint of
a *browser process* (Chrome, Electron, etc.). The guard exists so that only
non-browser HTTP clients can drive the MCP endpoint — a deliberate
client-identification choice, not a bug.

The catch: **Electron-based apps attach `Sec-Fetch-Site: same-site` to every
`fetch()` call.** Chatbox (and similar Electron apps) therefore cannot use
the neo server's HTTP MCP endpoint directly — every request dies at the
guard before the MCP layer is even reached. You'll see it as:

```
Streamable HTTP error: Error POSTing to endpoint: {"error":"unsupported request"}
```

Your other MCP servers (wikijs, headroom, etc.) work fine out of the box
because they are "dumb" MCP servers — they don't inspect or reject the kind
of client that connects. Neo does.

### The fix

This bridge is a plain **Node.js process**. A plain Node `fetch()` sends
neither `Sec-Fetch-Site` nor `Origin`, so the guard lets it through.
The bridge runs as a **stdio** MCP server: the client speaks JSON-RPC on
stdin/stdout (the most universal MCP transport — no HTTP headers involved),
and the bridge forwards `initialize` / `tools/list` / `tools/call` to neo
over HTTP (where the clean client is required).

```
Chatbox / Hermes / Claude Desktop        this process             BrowserOS neo
        (stdio MCP client)                (Node.js)              (Rust server)
           │                               │                       │
           │  JSON-RPC over stdin/stdout   │  HTTP POST (clean)    │
           └──────────────────────────────► │ ────────────────────► │
                    ◄───────────────────────┘ ◄───────────────────── │
           (JSON-RPC on stdout)                (SSE + JSON response)
```

Verified end-to-end on Windows 11 (2026-08-26):
- `initialize` → 51 ms, protocol `2025-06-18`, upstream `browseros-neo v0.0.44`
- `tools/list` → all **20 tools**: `tabs, tab_groups, history, navigate,
  snapshot, diff, act, download, upload, read, grep, screenshot, pdf, wait,
  windows, evaluate, run, name_session, save_skill, mark_skill_run`
- `tools/call` (`tabs`) → live round-trip: returned the user's real tab list
  from the neo browser.

The result: neo becomes usable as a normal MCP server from clients that the
direct HTTP endpoint would refuse — including the ones whose real, persistent,
headed browser profile is what gets through Google's CAPTCHA check
(agent-browser's headless + fresh-profile combo does not).

---

## What's in this folder

| File | Purpose |
|---|---|
| `neo-mcp-bridge.mjs` | The bridge. One file, **no npm dependencies**. |
| `bridge-test.mjs` | Self-test: spawns the bridge like a client would and runs `initialize` → `tools/list` → `tools/call(tabs)`. |
| `mcp-config-examples.json` | Ready-to-paste MCP config sections (Chatbox, Hermes, Claude Desktop). |
| `README.md` | This file. |

---

## Requirements

1. **Node.js ≥ 18** on the target machine (`node --version` to check;
   built-in `fetch` is the only non-trivial feature used). To install on a
   fresh Windows box: `winget install OpenJS.NodeJS.LTS` (or
   https://nodejs.org), then open a **new** terminal.
2. **BrowserOS neo running** on that machine — the neo/claw server with the
   MCP endpoint up. No auth token is required for the local endpoint.
3. Nothing else. There is no `package.json`, no `node_modules`, no install
   step.

---

## Installation

1. Copy this folder anywhere you like. Remember the full path of that
   folder — in the examples below it is written as
   `<path-to-browser-mcp-bridge>`; replace it with wherever you put it.
   Examples of what a filled-in path looks like:
   - Windows: `C:\Users\jane\Documents\browser-mcp-bridge`
   - Linux: `/home/jane/browser-mcp-bridge`
2. Confirm the neo server is running (the neo app's dashboard shows it; the
   default endpoints are `http://127.0.0.1:9210/mcp` direct and
   `http://127.0.0.1:9010/mcp` via the local proxy port — both work).
3. Run the self-test:

   ```powershell
   cd <path-to-browser-mcp-bridge>
   node bridge-test.mjs
   ```

   Expected output ends with `ALL PASSED` and lists 20 tools.

4. Add the MCP server entry to your client (see
   `mcp-config-examples.json`), then restart the client.

---

## MCP client configuration

### Chatbox (the shape verified working on Windows, 2026-08-26)

Chatbox's `config.json` (`%APPDATA%\xyz.chatboxapp.app\config.json`) stores
servers under `settings.mcp.servers`. The entry that works
(`<path-to-browser-mcp-bridge>` = the full path to the folder this bridge was
copied to):

```json
{
  "name": "BrowserOS",
  "enabled": true,
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": [
      "<path-to-browser-mcp-bridge>\\neo-mcp-bridge.mjs"
    ],
    "env": {
      "BROWSEROS_MCP_URL": "http://127.0.0.1:9210/mcp"
    }
  }
}
```

> Chatbox adds its own `id` field (a UUID) when you create the entry through
> the UI; it is not required if you hand-edit the JSON.
> `env` is optional — the default URL is `http://127.0.0.1:9210/mcp` — but
> keeping it explicit means the config documents exactly where it points.

### Generic MCP client (`.mcp.json` / `claude_desktop_config.json` style)

```json
{
  "mcpServers": {
    "browseros": {
      "command": "node",
      "args": ["<path-to-browser-mcp-bridge>/neo-mcp-bridge.mjs"],
      "env": {
        "BROWSEROS_MCP_URL": "http://127.0.0.1:9210/mcp"
      }
    }
  }
}
```

Filled-in examples of the `args` entry:

- **Windows:** `"C:/Users/jane/Documents/browser-mcp-bridge/neo-mcp-bridge.mjs"`
  (or with JSON-escaped backslashes:
  `"C:\\Users\\jane\\Documents\\browser-mcp-bridge\\neo-mcp-bridge.mjs"`)
- **Linux:** `"/home/jane/browser-mcp-bridge/neo-mcp-bridge.mjs"`

(On Windows, native tools accept forward-slash paths fine; backslashes are
also fine if JSON-escaped.)

---

## Configuration

| Setting | Where | Default | Notes |
|---|---|---|---|
| Upstream URL | env `BROWSEROS_MCP_URL` | `http://127.0.0.1:9210/mcp` | `9210` = direct port, `9010` = local proxy port. Both verified working; 9210 recommended. |
| Transport | — | stdio (fixed) | The bridge *is* the stdio side; there is no mode to switch. |
| Protocol | — | `2025-06-18` | Matches the MCP version neo speaks. |

## Protocol notes (how the bridge talks to neo)

- **Headers**: the bridge sends exactly `Content-Type: application/json` and
  `Accept: application/json, text/event-stream` — and *nothing else*. That is
  the whole trick: no `Sec-Fetch-Site`, no `Origin`. (The `Accept` value
  matters: omitting `text/event-stream` gets a 406 on some neo versions.)
- **Session**: `initialize` returns an `mcp-session-id` response header; the
  bridge stores it and echoes it as `Mcp-Session-Id` on every later request.
- **Responses are SSE**: neo wraps JSON-RPC responses in a
  `text/event-stream` body — an empty ping event first
  (`data:` / `id: 0` / `retry: 3000`), then the JSON-RPC message in a
  `data:` line. The bridge parses the last `data:` line that is valid JSON
  with an `id`. Plain-JSON responses are handled too, so either wire shape
  works.
- **Reconnect**: if neo is restarted, the stored session id goes stale. The
  bridge detects the stale-session error, re-initializes once, and retries
  the request transparently (one retry per request).

## Limitations

- One request in flight at a time (requests are processed sequentially per
  line on stdin). MCP clients serialize `tools/call` per connection in
  practice, so this is fine for normal agent use.
- The bridge forwards `initialize`, `tools/list`, and `tools/call`. Neo's
  tool set (v0.0.44) is tools-only, so nothing else is needed; any future
  method returns a clean JSON-RPC error rather than hanging.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED` / `fetch failed` at startup log | neo server isn't running, or the port moved. Open the neo app, check the dashboard, set `BROWSEROS_MCP_URL` to the real endpoint. |
| `403 unsupported request` | A *different* client is talking to neo directly with browser headers (or a proxy injected them). Make sure the client entry points at the **bridge** (stdio), not at the HTTP URL. |
| `406 Not Acceptable` | A client that omits `text/event-stream` from `Accept` — i.e., it's not using this bridge. Use the bridge. |
| `session … invalid` then success | Normal: neo was restarted mid-session; the bridge re-initialized automatically. |
| `node: command not found` (Linux/macOS client) | Put `node` on PATH for the client, or use the absolute path to `node` in `command`. |


---

## License

Copyright (C) 2026 Marc Christensen <mecworks@gmail.com>

This project is licensed under the GNU General Public License v2.0 only —
see the [LICENSE](LICENSE) file for the full text.
