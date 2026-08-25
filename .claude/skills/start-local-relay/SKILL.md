---
name: start-local-relay
description: Start (or check the status of) the Claude Code Side Panel's relay server pointed at the user's local Ollama model instead of the cloud. Use this whenever the user asks to start/run/launch the local relay, switch the side panel to the local model, or use local-relay.
---

# Start local relay

Same relay server as `start-relay-server`
(`claude-code-sidepanel/relay-server/server.js`), but started with env vars
that redirect every request to a local Ollama model instead of the cloud.
Only one relay process can hold port 8787 at a time, so starting this one
means the cloud model can't respond until the relay is switched back.

## Steps

1. **Check what's currently on port 8787:**

   ```bash
   curl -sf http://localhost:8787/health && echo ALREADY_RUNNING
   ```

   A health check succeeding doesn't tell you which backend (cloud or
   local) that instance is using — if the user is asking to switch to
   local, stop whatever's running rather than assuming it's already right:

   ```bash
   lsof -ti:8787 | xargs kill 2>/dev/null
   ```

2. **Start it in the background** with the local-model env vars:

   ```bash
   ANTHROPIC_BASE_URL=http://192.168.0.112:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" CLAUDE_MODEL=gemma4:12b-it-qat node "claude-code-sidepanel/relay-server/server.js"
   ```

   Run this with the Bash tool's `run_in_background` option — it's meant to
   keep running indefinitely, don't block waiting on it.

3. **Confirm it came up** by polling `curl -sf http://localhost:8787/health`
   once it's had a moment to start. Report the result to the user, and
   remind them this relay is now talking to the local model exclusively —
   to go back to the cloud, stop this process and start the relay plainly
   (`node server.js`, no env vars) instead.

4. If the health check fails, check the background task's output before
   assuming it's broken — a wrong `ANTHROPIC_BASE_URL` (host unreachable) or
   a bad `CLAUDE_MODEL` name are the most likely causes, not the relay code
   itself. The relay also gives up and reports a clear error if `claude`
   produces no output for 2 minutes, rather than hanging forever.
