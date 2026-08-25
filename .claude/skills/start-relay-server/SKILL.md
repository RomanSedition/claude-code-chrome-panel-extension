---
name: start-relay-server
description: Start (or check the status of) the Claude Code Side Panel's local relay server, the Node process at claude-code-sidepanel/relay-server/server.js that the Chrome extension talks to on http://localhost:8787. Use this whenever the user asks to start/run/launch the relay, the server, or the backend for this extension, or says the side panel's status dot is red / extension can't connect.
---

# Start relay server

The Chrome extension's side panel is useless without this server running —
it's what actually shells out to the `claude` CLI. Before starting a new
instance, check whether one is already up so you don't spawn a duplicate
bound to the same port.

## Steps

1. **Check if it's already running:**

   ```bash
   curl -sf http://localhost:8787/health && echo ALREADY_RUNNING
   ```

   If that prints `{"status":"ok"}ALREADY_RUNNING`, tell the user it's
   already running and stop here.

2. **Start it in the background:**

   ```bash
   cd "claude-code-sidepanel/relay-server" && node server.js
   ```

   Run this with the Bash tool's `run_in_background` option (do not block
   the conversation waiting on it — this process is meant to keep running
   indefinitely). If `run_in_background` isn't available, fall back to
   `nohup node server.js > /tmp/relay-server.log 2>&1 &`.

3. **Confirm it came up** by polling `curl -sf http://localhost:8787/health`
   once (a plain retry is fine; it starts almost instantly). Report the
   result to the user — e.g. "Relay server is running on
   http://localhost:8787." If the port is already taken by something else,
   the health check will still fail; check `/tmp/relay-server.log` or the
   background task's output for the actual error (commonly
   `EADDRINUSE`) rather than assuming it's healthy.

4. Remind the user, only if relevant, that the server requires the `claude`
   CLI to be installed and logged in, since it spawns
   `claude --continue -p "<prompt>" --output-format stream-json` per
   request.
