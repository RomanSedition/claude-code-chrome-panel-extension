# Claude Code Side Panel

A Chrome side panel that lets you send prompts into your running Claude Code
session without alt-tabbing out of your browser.

Two pieces:
- `relay-server/` — a small local Node server that shells out to the `claude`
  CLI and streams responses back over HTTP as it generates them.
- `extension/` — a Chrome extension (Manifest V3) with a side panel UI that
  talks to the relay server.

Everything runs locally on your machine. No data leaves your computer except
what Claude Code itself sends to Anthropic as normal.

## 1. Start the relay server

Requires Node.js and the `claude` CLI already installed and logged in.

```bash
cd relay-server
node server.js
```

You should see:

```
Claude Code relay listening on http://localhost:8787
```

Leave this running in a terminal alongside your normal Claude Code session.

**Important:** on every request, the relay scans `~/.claude/projects/` for
whichever session file (across every project) was modified most recently, and
resumes that one directly with `--resume`. In practice this means the panel
continues whatever Claude Code conversation you were just using — including
an interactive session open in VS Code or a terminal — without you having to
configure a project path. The header shows a small 📁 badge naming the folder
of the session it's currently targeting, so you can tell at a glance.

This assumes you're not running more than one Claude Code session at the same
moment. If you are, both processes end up writing to the same session file at
once — in testing this reliably caused the CLI to abandon that file and start
a new one instead, losing the conversation you were resuming. Treat the panel
as an alternative to typing into an already-open Claude Code session, not a
second one running alongside it. (If no session exists anywhere yet, it falls
back to plain `--continue`.)

## 2. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Pin the extension icon to your toolbar if you want quick access

The extension asks for permission to read and change data on all sites
(`tabs` + `scripting` + `<all_urls>`) — this is what lets it read the current
page's content and draw on-page highlights (see below). It's only ever used
when you explicitly ask it to (the "Include current page" checkbox, or a
highlight request); it doesn't run in the background otherwise.

## 3. Open the side panel

Click the extension icon — it should open the side panel docked to the
current window. The dot next to "Claude Code" in the header turns green when
it can reach the relay server, red when it can't.

Keep the panel open next to whatever you're working on, type a prompt, and
hit **Enter** (or click **Send**). The response streams in as Claude Code
generates it.

## Features

- **Streaming replies with a live status line** — while Claude is working,
  the reply shows an animated "Waiting…" / "Thinking… (~N tokens)" /
  "Responding…" indicator with a live elapsed timer. Once done, it collapses
  into a summary like `Thought for 2.1s · sent 36.4k tokens · replied 84
  tokens`.
- **Header badges** — a pill showing whether you're talking to the cloud
  model or a local one (see "Custom / local model providers" below), and a
  📁 badge naming the project folder of the Claude Code session currently
  being resumed.
- **Copyable code blocks** — any fenced code block in a reply renders as a
  styled box with a one-click copy button, instead of raw text.
- **Paste-to-attach images** — paste a screenshot (Cmd/Ctrl+V) straight into
  the input box to attach it; it shows as a removable thumbnail and gets sent
  to Claude as an image.
- **Prompt history** — press **↑** / **↓** at the start/end of the input box
  to cycle back through previously sent prompts, shell-style.
- **Single-flight requests** — only one prompt can be in flight at a time;
  a second send while one's running is rejected rather than racing it.

### Currently disabled: page context and on-page highlighting

- **"Include current page" context** sends the active tab's URL, title, and
  visible text along with your prompt, so you can ask about "this page"
  without pasting a URL.
- **On-page highlighting** lets you ask Claude to "circle X" / "highlight X"
  / "find X on this page", drawing a hand-drawn-style red rectangle around
  the real text on the page (with a scribble sound as it's drawn and a ding
  when done). Works for real DOM text (headings, labels, buttons — e.g.
  Figma's UI chrome); it can't reach into a canvas or image (e.g. shapes on
  a design canvas). Highlight mode (the red button next to Send) is a
  shortcut that auto-wraps whatever you type as a highlight request instead
  of you typing "please circle X" each time.

Both are **turned off by default** — highlighting depends on page context,
and resending a page's full text with every single prompt turned out to be
expensive, especially once a session's history has grown large (every prompt
pays to replay it, page context or not). To turn them back on, open
`extension/sidepanel.js` and flip `HIGHLIGHT_AND_PAGE_CONTEXT_DISABLED` to
`false` near the top of the file, then reload the extension.

## Notes / things you may want to tweak

- **Port**: default is `8787`. Change `PORT` in `server.js` and the
  `RELAY_URL` constant in `extension/sidepanel.js` together if you need a
  different one.
- **Streaming format**: Claude Code's `stream-json` event shape can change
  between CLI versions. If responses look empty, garbled, or the thinking/
  token UI stops updating, run
  `claude -p "hi" --output-format stream-json --include-partial-messages --verbose`
  directly in a terminal to see the raw event structure, and adjust
  `makeTranslator()` in `server.js` to match.
- **Security**: the relay server has no auth and accepts requests from any
  local origin. That's fine for solo local use, but don't expose port 8787
  to your network or run this on a shared machine.
- **Multiple sessions**: see the session-targeting note near the top — the
  relay always resumes whichever session was modified most recently across
  every project, so don't run it alongside another active Claude Code
  session (see above for what goes wrong if you do).
- **Harmless provider warnings filtered out**: pointing at a custom provider
  makes `claude` print a couple of informational (non-error) stderr lines —
  a connectors-disabled notice and an unrecognized-model warning for a
  non-Anthropic model name. Both are dropped before reaching the extension;
  real errors still come through. See `HARMLESS_STDERR_PATTERNS` in
  `server.js` if a CLI update ever changes that wording.
- **Custom / local model providers**: if you normally run `claude` pointed at
  a local model (Ollama, etc.) via env vars like `ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, those need to be set in the
  *same* environment you start the relay from — a shell alias's inline
  `VAR=value` only applies to that one command, it doesn't persist into
  other commands (like `node server.js`) run afterward in the same terminal.
  If your alias also passes `--model`, that's a CLI flag, not an env var, so
  it won't inherit at all — set `CLAUDE_MODEL` and the relay forwards it as
  `--model` itself. Example, matching an alias like
  `ANTHROPIC_BASE_URL=http://host:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" claude --model my-model`:

  ```bash
  ANTHROPIC_BASE_URL=http://host:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY="" CLAUDE_MODEL=my-model node server.js
  ```
- **Timeouts**: if `claude` produces no output for 2 minutes (a hung/
  unreachable provider, bad auth, etc.), the relay kills it and reports a
  clear error instead of hanging forever. Adjust `REQUEST_TIMEOUT_MS` in
  `server.js` if a slower local model needs more headroom.
