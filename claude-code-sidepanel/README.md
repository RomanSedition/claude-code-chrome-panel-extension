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

**Important:** the relay uses `claude --continue`, which resumes your most
recently active Claude Code session on this machine. Make sure you've started
(or previously used) Claude Code in your project folder at least once before
sending prompts from the panel — otherwise there's no session to continue. If
you juggle multiple projects/sessions, open `relay-server/server.js` and swap
`--continue` for `--resume YOUR_SESSION_ID` to target a specific one.

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
- **Copyable code blocks** — any fenced code block in a reply renders as a
  styled box with a one-click copy button, instead of raw text.
- **Paste-to-attach images** — paste a screenshot (Cmd/Ctrl+V) straight into
  the input box to attach it; it shows as a removable thumbnail and gets sent
  to Claude as an image.
- **Prompt history** — press **↑** / **↓** at the start/end of the input box
  to cycle back through previously sent prompts, shell-style.
- **"Include current page" context** — checked by default; sends the active
  tab's URL, title, and visible text along with your prompt, so you can ask
  about "this page" without pasting a URL. Automatically disabled on pages it
  can't read (`chrome://`, the Web Store, etc.), and honestly tells you when
  a long page's content had to be truncated rather than silently guessing.
- **On-page highlighting** — ask Claude to "circle X" / "highlight X" / "find
  X on this page" and it'll draw a hand-drawn-style red rectangle around the
  real text on the page (with a scribble sound as it's drawn and a ding when
  done — toggle the 🔊 icon to mute). Works for real DOM text (headings,
  labels, buttons — e.g. Figma's UI chrome); it can't reach into a canvas or
  image (e.g. shapes on a design canvas).
  - **Highlight mode** (the red "Highlight" button next to Send): a shortcut
    that skips typing out "please circle X" — whatever you type is
    auto-wrapped as a highlight request and sent to Claude. Locks "Include
    current page" on (required for it to find anything) and disables image
    pasting while active, since there's nothing to send an image to.
- **Single-flight requests** — only one prompt can be in flight at a time;
  a second send while one's running is rejected rather than racing it.

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
- **Multiple sessions**: `--continue` always targets your most recent
  session for the relay's own working directory. If you're also running
  Claude Code interactively in a terminal at the same time from a different
  directory, the two won't collide; from the same directory, they'll share
  one conversation.
