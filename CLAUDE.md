# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome extension (Manifest V3) with a side panel UI that sends prompts into
a locally running `claude` CLI session, plus a local Node relay server that
bridges the two over HTTP. Everything lives under `claude-code-sidepanel/`.

There is no build step and no npm dependencies — plain JS/HTML/CSS in the
extension, and the relay server uses only Node's built-in `http` and
`child_process` modules.

## Commands

Run the relay server (required for the extension to work):

```bash
cd claude-code-sidepanel/relay-server
node server.js
```

Load the extension in Chrome: go to `chrome://extensions`, enable Developer
mode, "Load unpacked", select `claude-code-sidepanel/extension/`.

There is no build, lint, or test tooling in this repo — changes to the
extension are verified by reloading it in `chrome://extensions` and changes
to the relay by restarting `node server.js`.

## Architecture

Two independent pieces talking over HTTP on `localhost:8787`:

- **`extension/`** — the Chrome side panel UI.
  - `background.js` — service worker; only wires the toolbar icon to open
    the side panel.
  - `sidepanel.js` — polls `GET /health` every 5s to show a green/red status
    dot, and on send does `POST /prompt` with `{ prompt }`, then reads the
    response body as a stream and appends text chunks live into the output.
  - `manifest.json` declares `host_permissions: ["http://localhost/*"]` —
    if the relay port changes, this must be kept in sync (see below).

- **`relay-server/server.js`** — a single-file HTTP server that:
  1. Receives `POST /prompt` with a prompt string.
  2. Spawns `claude --continue -p "<prompt>" --output-format stream-json`.
  3. Parses the newline-delimited JSON events from stdout, pulls plain text
     out via `extractText()`, and writes it to the HTTP response as chunked
     plain text so the extension can stream it in real time.
  4. Kills the `claude` subprocess if the client disconnects mid-stream.

### Key coupling points to keep in sync

- **Port**: hardcoded as `PORT = 8787` in `server.js` and
  `RELAY_URL` in `extension/sidepanel.js`. Changing one requires changing
  the other (and the `manifest.json` host permission if the host changes
  too).
- **Streaming event shape**: `extractText()` in `server.js` depends on the
  exact shape of `claude --output-format stream-json` events, which can
  change between CLI versions. If responses look empty or garbled, run
  `claude -p "hi" --output-format stream-json` directly in a terminal to
  inspect the real event structure and adjust `extractText()` to match.
- **Session targeting**: the relay always uses `claude --continue`, which
  resumes whichever Claude Code session was most recently active on the
  machine — not a session scoped to this extension. A prompt sent from the
  panel and one typed in a terminal Claude Code session land in the same
  conversation. To target a specific session instead, swap `--continue` for
  `--resume YOUR_SESSION_ID` in `server.js`.
- **No auth**: the relay accepts requests from any local origin
  (`Access-Control-Allow-Origin: *`) and has no authentication. This is
  intentional for solo local use — do not expose port 8787 beyond
  localhost.
