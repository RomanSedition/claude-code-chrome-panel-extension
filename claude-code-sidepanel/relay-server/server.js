// Claude Code relay server
//
// Runs locally alongside your Claude Code terminal session. Accepts prompts
// over HTTP from the Chrome side panel extension, relays them into your
// existing Claude Code session via `claude --continue`, and streams the
// response back as it's generated.
//
// Usage:
//   node server.js
//
// Requires the `claude` CLI to be installed and already logged in on this
// machine. No npm dependencies — uses only Node's built-in http module.

const http = require('http');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 8787;

// `claude --continue` resumes a session scoped to the relay's own working
// directory, which is usually NOT the project your interactive Claude Code
// session (e.g. the one open in VS Code) actually runs from — the two end
// up as separate, unrelated conversations. Every session is stored as
// ~/.claude/projects/<project>/<session-id>.jsonl regardless of which
// directory it's for, so finding whichever one was modified most recently
// and resuming THAT file directly reliably targets "whatever Claude Code
// session you were just using", matching --continue's intent without the
// cwd-scoping quirk. (This assumes only one Claude Code session is active
// at a time — resuming a session that's concurrently open elsewhere causes
// the same file to be written by two processes at once.)
function findMostRecentSessionFile() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let best = null; // { file, mtimeMs }
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(dir, file));
      } catch {
        continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file: path.join(dir, file), mtimeMs: stat.mtimeMs };
    }
  }
  return best?.file || null;
}

// The ~/.claude/projects/<encoded-path> folder name isn't reliably
// decodable back into a real path (both "/" and literal spaces become "-"),
// but each transcript record carries the exact, real cwd it was written
// from — read that instead. The first line or two are queue-bookkeeping
// entries with no cwd field, so scan forward until one has it.
function getSessionInfo(sessionFile) {
  if (!sessionFile) return null;
  const sessionId = path.basename(sessionFile, '.jsonl');
  let cwd = null;
  try {
    const fd = fs.openSync(sessionFile, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.cwd) {
          cwd = event.cwd;
          break;
        }
      } catch {
        // last line in the buffer is likely cut off mid-JSON — skip
      }
    }
  } catch {
    // file unreadable — leave cwd null
  }
  return { sessionId, cwd };
}

// Set this (along with ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / etc. in
// the same environment this server is started from) to point at a custom
// provider — e.g. a local model served through Ollama. Plain env vars
// inherit into the spawned `claude` process automatically; --model doesn't,
// since it's a CLI flag, not an env var, so it has to be forwarded here.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || null;

// Known-harmless stderr noise the `claude` CLI prints when pointed at a
// custom/local provider — not errors, just informational, and confusing to
// see on every single response. Filtered here rather than in the extension
// since this is the one place stderr text passes through.
const HARMLESS_STDERR_PATTERNS = [
  /connectors are disabled because/i,
  /unrecognized_model/i,
];
function isHarmlessStderr(line) {
  return HARMLESS_STDERR_PATTERNS.some((re) => re.test(line));
}

// Only one `claude --continue` process may run at a time — a second one
// spawned while the first is still in flight would race it for the same
// resumed session.
let claudeBusy = false;

// Formats the active tab's URL/title/text (sent by the extension so the
// model can see what the user is looking at without them pasting the URL)
// as a text block prepended to the user's prompt.
function formatPageContext(pageContext) {
  if (!pageContext) return '';
  const { url, title, text, truncated } = pageContext;
  return `[The user is currently viewing this page in their browser]
URL: ${url}
Title: ${title}

Page content${truncated ? ' (TRUNCATED — this is only the first portion of the page; there is more below that you cannot see, so never claim something is absent from the page based on this alone)' : ''}:
"""
${text || '(no text extracted)'}
"""

If the user asks you to point out, circle, highlight, or locate something on this page, include a line in your reply formatted exactly as:
HIGHLIGHT: <short exact substring from the page content above>
Keep it under ~10 words, copied verbatim (including capitalization) from the page content above, and anchor it to the specific thing asked for — not a heading or label near it. If asked to highlight a whole paragraph, quote the first several words of that paragraph's own body text (never the section heading above it, even if the paragraph doesn't have its own heading — a heading and the paragraph under it are different targets). A long exact quote of the full passage is unnecessary and fragile (the match fails if it's reproduced even slightly wrong): the marker is only drawn tightly around whatever short snippet you give, not the whole passage, but a snippet from the right starting point still points the user at the right place. You can include multiple HIGHLIGHT lines for multiple items. This only works for real text on the page — it can't locate things drawn inside a canvas/image (e.g. shapes on a design canvas). Still answer normally in prose; the HIGHLIGHT line(s) are a directive for drawing an on-page marker and won't be shown to the user as text.

`;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Turns Claude Code's raw stream-json events (from --include-partial-messages)
// into a small set of UI events for the extension: thinking start/end,
// live thinking-token counts, text deltas, and a final usage/timing summary.
// The exact event shape can shift between CLI versions — if output looks
// empty/garbled, run
// `claude -p "hi" --output-format stream-json --include-partial-messages --verbose`
// directly in a terminal to inspect the real event structure and adjust this.
function makeTranslator() {
  const blockTypes = {}; // content_block index -> type ("thinking" | "text")

  return function translate(event) {
    const out = [];

    if (event.type === 'system' && event.subtype === 'status') {
      out.push({ type: 'status', status: event.status });
    } else if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      out.push({ type: 'thinking_tokens', estimatedTokens: event.estimated_tokens });
    } else if (event.type === 'stream_event') {
      const se = event.event;
      if (se.type === 'content_block_start') {
        blockTypes[se.index] = se.content_block?.type;
        if (blockTypes[se.index] === 'thinking') out.push({ type: 'thinking_start' });
      } else if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta') {
        out.push({ type: 'text_delta', text: se.delta.text });
      } else if (se.type === 'content_block_stop') {
        if (blockTypes[se.index] === 'thinking') out.push({ type: 'thinking_end' });
        delete blockTypes[se.index];
      }
    } else if (event.type === 'result') {
      out.push({
        type: 'done',
        usage: event.usage,
        durationMs: event.duration_ms,
        costUsd: event.total_cost_usd,
      });
    }

    return out;
  };
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      busy: claudeBusy,
      // ANTHROPIC_BASE_URL set means this relay was started pointed at a
      // custom (e.g. local Ollama) provider rather than the default cloud.
      provider: { local: Boolean(process.env.ANTHROPIC_BASE_URL), model: CLAUDE_MODEL },
      session: getSessionInfo(findMostRecentSessionFile()),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/prompt') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let prompt, images, pageContext;
      try {
        const parsed = JSON.parse(body);
        prompt = parsed.prompt;
        images = parsed.images || [];
        pageContext = parsed.pageContext || null;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body, expected { "prompt": "..." }' }));
        return;
      }

      if ((!prompt || !prompt.trim()) && images.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prompt cannot be empty' }));
        return;
      }

      if (claudeBusy) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A prompt is already in progress. Wait for it to finish before sending another.' }));
        return;
      }
      claudeBusy = true;

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      });

      // --continue resumes your most recently active Claude Code session.
      // If you run multiple sessions and need a specific one, replace this
      // with ['--resume', 'YOUR_SESSION_ID', '-p', prompt, ...].
      //
      // --include-partial-messages surfaces thinking/text as they stream in
      // (rather than only once a block is complete), which is what drives
      // the live thinking indicator and token counts in the side panel.
      //
      // Plain text prompts go through -p as a CLI arg. Prompts with images
      // can't be passed that way, so they go through --input-format
      // stream-json instead: a single user-message event (matching the
      // Messages API content-block shape) written to stdin.
      const fullText = formatPageContext(pageContext) + (prompt || '');

      // Re-checked on every request so it always follows whichever session
      // was actually most recently active, not whatever it resolved to on
      // the first request.
      const mostRecentSession = findMostRecentSessionFile();
      const sessionArgs = mostRecentSession ? ['--resume', mostRecentSession] : ['--continue'];

      let args, claude;
      const commonArgs = [...sessionArgs, '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
      if (CLAUDE_MODEL) commonArgs.push('--model', CLAUDE_MODEL);
      if (images.length > 0) {
        args = ['-p', '--input-format', 'stream-json', ...commonArgs];
        claude = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const content = [];
        if (fullText.trim()) content.push({ type: 'text', text: fullText });
        for (const img of images) {
          content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        }
        claude.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      } else {
        args = ['-p', fullText, ...commonArgs];
        claude = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      }

      const translate = makeTranslator();
      const writeEvent = (event) => res.write(JSON.stringify(event) + '\n');

      // A multi-byte UTF-8 character (e.g. "⅓") can land right on a stdout
      // chunk boundary. Calling .toString() on each raw chunk independently
      // would corrupt it into replacement characters — StringDecoder holds
      // back an incomplete trailing sequence until the next chunk completes
      // it, decoding correctly across boundaries.
      const stdoutDecoder = new StringDecoder('utf8');
      let leftover = '';
      claude.stdout.on('data', (data) => {
        const chunk = leftover + stdoutDecoder.write(data);
        const lines = chunk.split('\n');
        leftover = lines.pop(); // last line may be incomplete, hold it
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            for (const outEvent of translate(event)) writeEvent(outEvent);
          } catch {
            // partial or non-JSON line — skip
          }
        }
      });

      // Buffered by line (not just passed through per raw chunk) so a
      // known-harmless message can be matched and dropped in full even if
      // it happens to straddle a chunk boundary.
      const stderrDecoder = new StringDecoder('utf8');
      let stderrLeftover = '';
      const flushStderrLine = (line) => {
        if (!line.trim() || isHarmlessStderr(line)) return;
        writeEvent({ type: 'stderr', text: line + '\n' });
      };
      claude.stderr.on('data', (data) => {
        const chunk = stderrLeftover + stderrDecoder.write(data);
        const lines = chunk.split('\n');
        stderrLeftover = lines.pop();
        for (const line of lines) flushStderrLine(line);
      });

      // If `claude` hangs — a misconfigured provider (ANTHROPIC_API_KEY /
      // ANTHROPIC_BASE_URL pointing at an unreachable or misbehaving local
      // model), a network issue, anything — there was previously no limit:
      // claudeBusy would stay true forever and the request would just hang
      // with no feedback. Kill it and report clearly instead.
      const REQUEST_TIMEOUT_MS = 120000;
      const timeoutId = setTimeout(() => {
        writeEvent({
          type: 'relayError',
          message: `'claude' produced no response for ${REQUEST_TIMEOUT_MS / 1000}s — if you're using a custom provider (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL pointing at a local model), check it's reachable and correctly set in the environment this relay server was started from.`,
        });
        claude.kill();
      }, REQUEST_TIMEOUT_MS);

      claude.on('error', (err) => {
        clearTimeout(timeoutId);
        claudeBusy = false;
        writeEvent({ type: 'relayError', message: `Could not run 'claude': ${err.message}` });
        res.end();
      });

      claude.on('close', (code) => {
        clearTimeout(timeoutId);
        claudeBusy = false;
        if (stderrLeftover) flushStderrLine(stderrLeftover);
        writeEvent({ type: 'closed', code });
        res.end();
      });

      // res (not req) 'close' fires when the client disconnects mid-response —
      // req 'close' fires as soon as the request body is fully read, which is
      // far too early and would kill claude before it can respond.
      res.on('close', () => {
        claude.kill();
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Claude Code relay listening on http://localhost:${PORT}`);
  console.log(`POST prompts to http://localhost:${PORT}/prompt`);
});
