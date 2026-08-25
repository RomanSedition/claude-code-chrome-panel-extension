const RELAY_URL = 'http://localhost:8787';

const promptInput = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const output = document.getElementById('output');
const statusDot = document.getElementById('status-dot');
const attachmentsEl = document.getElementById('attachments');
const includePageCheckbox = document.getElementById('include-page');
const pageContextRow = document.getElementById('page-context-row');
const pageContextLabel = document.getElementById('page-context-label');
const highlightToggleBtn = document.getElementById('highlight-toggle');

// When on, whatever is typed still goes through the normal AI prompt path
// (so Claude can use its page context to find the right exact text, not
// just a literal substring match) — it's just auto-wrapped as a "Highlight
// X on this page" request, saving the user from typing that out each time.
// Clipboard images are ignored while active since there's nothing to send
// them to, and "Include current page" is forced on since the model needs
// that context to find anything at all.
let highlightMode = false;

function setHighlightMode(on) {
  highlightMode = on;
  highlightToggleBtn.classList.toggle('active', on);
  promptInput.placeholder = on
    ? 'Type what to find and circle on the page...  (Enter to send)'
    : 'Send a prompt to your Claude Code session...  (Enter to send, Shift+Enter for a new line, paste an image to attach it)';
  if (on) {
    pendingImages = [];
    renderAttachments();
    includePageCheckbox.checked = true;
    includePageCheckbox.disabled = true;
    pageContextRow.title = 'Locked on while Highlight mode is active — Claude needs the page content to find anything.';
  } else {
    pageContextRow.title = '';
    refreshPageContextLabel(); // restores disabled/checked state for the real current page
  }
}

highlightToggleBtn.addEventListener('click', () => setHighlightMode(!highlightMode));

let sending = false;

const PAGE_CONTEXT_MAX_CHARS = 60000;

// Reads the active tab's URL/title/text so the model can see what the user
// is looking at without them having to paste the URL. Requires "tabs" +
// "scripting" + host access to all sites (declared in manifest.json).
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getPageContext(tab) {
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (maxChars) => {
        const fullText = document.body ? document.body.innerText : '';
        return {
          url: location.href,
          title: document.title,
          text: fullText.slice(0, maxChars),
          truncated: fullText.length > maxChars,
        };
      },
      args: [PAGE_CONTEXT_MAX_CHARS],
    });
    return result;
  } catch {
    // injection blocked (chrome web store pages, etc.) — fall back to just the tab's own metadata
    return { url: tab.url, title: tab.title || '', text: '', truncated: false };
  }
}

// Runs inside the target page (via chrome.scripting.executeScript) to find
// the given text and draw a hand-drawn-style red rectangle around it. Must
// be fully self-contained — no references to outer sidepanel.js scope.
function highlightTextOnPage(searchText) {
  document.getElementById('__claude_highlight_overlay')?.remove();

  // Flattens all text nodes under <body> into one string, remembering which
  // node each character came from. A plain per-node search misses common
  // cases like a heading sitting right next to its "[edit]" link — those
  // are separate text nodes that only form one string once concatenated.
  function buildTextIndex() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      nodes.push({ node, start: text.length });
      text += node.textContent;
    }
    return { text, nodes };
  }

  function locate(nodes, pos) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].start <= pos) {
        return { node: nodes[i].node, offset: Math.min(pos - nodes[i].start, nodes[i].node.textContent.length) };
      }
    }
    return null;
  }

  // Lowercases and maps back to original character positions. When
  // splitOnPunct is false, non-alphanumeric characters other than
  // whitespace are dropped with no substitute — matches e.g. "Castingedit"
  // against the page's "Casting[edit]" (adjacent nodes with no gap). When
  // true, ALL non-alphanumeric runs (including hyphens/dashes) become a
  // single space — matches e.g. "book and record set" against the page's
  // "Book-and-record set".
  function normalize(text, splitOnPunct) {
    let norm = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/[a-z0-9]/i.test(ch)) {
        norm += ch.toLowerCase();
        map.push(i);
      } else if ((splitOnPunct || /\s/.test(ch)) && norm[norm.length - 1] !== ' ') {
        norm += ' ';
        map.push(i);
      }
    }
    return { norm, map };
  }

  function findRange(searchText) {
    const { text, nodes } = buildTextIndex();

    function tryExact() {
      const idx = text.toLowerCase().indexOf(searchText.toLowerCase());
      return idx === -1 ? null : [idx, idx + searchText.length];
    }

    function tryNormalized(splitOnPunct) {
      const haystack = normalize(text, splitOnPunct);
      const needle = normalize(searchText, splitOnPunct).norm;
      if (!needle) return null;
      const idx = haystack.norm.indexOf(needle);
      if (idx === -1) return null;
      return [haystack.map[idx], haystack.map[idx + needle.length - 1] + 1];
    }

    const span = tryExact() || tryNormalized(false) || tryNormalized(true);
    if (!span) return null;
    const [start, end] = span;

    const startLoc = locate(nodes, start);
    const endLoc = locate(nodes, end);
    if (!startLoc || !endLoc) return null;

    const range = document.createRange();
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset);
    return range;
  }

  const range = findRange(searchText);
  if (!range) return Promise.resolve({ found: false });

  const anchorEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;

  // scrollIntoView's behavior option can still be overridden by the page's
  // own CSS (e.g. a `scroll-behavior: smooth` rule on <html>), which turns
  // it into a multi-frame animation instead of an instant jump. An inline
  // style beats any stylesheet rule, so force it off for the duration of
  // this call — that removes the animation instead of racing it.
  const htmlEl = document.documentElement;
  const prevScrollBehavior = htmlEl.style.scrollBehavior;
  htmlEl.style.scrollBehavior = 'auto';
  anchorEl?.scrollIntoView({ block: 'center', inline: 'center' });
  htmlEl.style.scrollBehavior = prevScrollBehavior;

  const DRAW_MS = 550;

  // Belt-and-suspenders: even with instant scrolling forced above, other
  // things (lazy-loaded images, sticky headers) can still shift layout for
  // a frame or two. Wait for the target's position to be stable across
  // several consecutive frames — not just one pair, since a slow-ending
  // scroll animation (if one somehow still occurs) can look momentarily
  // stable mid-motion — before measuring where to draw.
  function waitForScrollSettle(onSettled, framesLeft = 30) {
    let lastTop = null;
    let stableFrames = 0;
    function check() {
      const top = range.getBoundingClientRect().top;
      stableFrames = lastTop !== null && Math.abs(top - lastTop) < 0.5 ? stableFrames + 1 : 0;
      lastTop = top;
      framesLeft--;
      if (stableFrames >= 4 || framesLeft <= 0) onSettled();
      else requestAnimationFrame(check);
    }
    check();
  }

  return new Promise((resolve) => {
    waitForScrollSettle(() => {
      const rect = range.getBoundingClientRect();
      // A rectangle hugs the target far more tightly than an ellipse would
      // (an ellipse needs a lot of extra margin to avoid clipping the corners
      // of a wide, short box), so it covers a lot less of the surrounding page.
      const pad = 6;
      const overshoot = 6; // small closing overshoot, like a quickly hand-drawn box
      const x = rect.left - pad;
      const y = rect.top - pad;
      const w = rect.width + pad * 2;
      const h = rect.height + pad * 2;

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.id = '__claude_highlight_overlay';
      svg.setAttribute('style', 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;overflow:visible;');

      const defs = document.createElementNS(svgNS, 'defs');
      const filter = document.createElementNS(svgNS, 'filter');
      filter.id = '__claude_sketchy';
      filter.innerHTML =
        '<feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="3" result="noise"/>' +
        '<feDisplacementMap in="SourceGraphic" in2="noise" scale="4"/>';
      defs.appendChild(filter);
      svg.appendChild(defs);

      const d = `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} L ${x} ${y - overshoot}`;
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#ff3b30');
      path.setAttribute('stroke-width', '4');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('filter', 'url(#__claude_sketchy)');
      svg.appendChild(path);
      document.body.appendChild(svg);

      // Reveal the path progressively (like it's being drawn) instead of
      // just fading in — timed to line up with the scribble sound.
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);

      requestAnimationFrame(() => {
        path.style.transition = `stroke-dashoffset ${DRAW_MS}ms ease-out`;
        path.style.strokeDashoffset = '0';
      });

      setTimeout(() => resolve({ found: true }), DRAW_MS + 50);

      setTimeout(() => {
        path.style.transition = 'opacity 0.3s ease';
        path.style.opacity = '0';
        setTimeout(() => svg.remove(), 400);
      }, 6000);
    });
  });
}

// Sound effects for the highlight action, synthesized with the Web Audio
// API (no audio asset files needed). Played from the side panel itself
// rather than injected into the target page, so they aren't subject to that
// page's autoplay/CSP restrictions.
const soundToggle = document.getElementById('sound-toggle');
soundToggle.checked = localStorage.getItem('highlightSoundsEnabled') !== 'false';
soundToggle.addEventListener('change', () => {
  localStorage.setItem('highlightSoundsEnabled', String(soundToggle.checked));
});

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Filtered noise burst with a wobbling bandpass filter, for a scratchy
// pen-on-paper feel. Returns a stop() to cut it short if needed.
function playScribbleSound(durationMs) {
  const ctx = getAudioCtx();
  const seconds = durationMs / 1000;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 2200;
  bandpass.Q.value = 0.7;

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 18;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 600;
  lfo.connect(lfoGain);
  lfoGain.connect(bandpass.frequency);

  const gain = ctx.createGain();
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.03);
  gain.gain.setValueAtTime(0.18, now + Math.max(seconds - 0.08, 0.03));
  gain.gain.linearRampToValueAtTime(0.0001, now + seconds);

  noise.connect(bandpass);
  bandpass.connect(gain);
  gain.connect(ctx.destination);

  lfo.start(now);
  noise.start(now);
  lfo.stop(now + seconds);
  noise.stop(now + seconds);

  return () => {
    try {
      noise.stop();
      lfo.stop();
    } catch {
      // already stopped
    }
  };
}

// A bright two-note chime for "done".
function playDingSound() {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  for (const [freq, peak, delay] of [
    [1318.51, 0.22, 0],
    [1975.53, 0.14, 0.05],
  ]) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    const start = now + delay;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.9);
  }
}

async function triggerHighlight(targetText) {
  const tab = await getActiveTab();
  if (!tab || !/^https?:/.test(tab.url || '')) {
    return `[couldn't highlight "${targetText}" — no active page]`;
  }
  const soundsOn = soundToggle.checked;
  const stopScribble = soundsOn ? playScribbleSound(550) : null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightTextOnPage,
      args: [targetText],
    });
    stopScribble?.();
    if (result?.found && soundsOn) playDingSound();
    return result?.found
      ? `[🔴 highlighted "${targetText}" on the page]`
      : `[couldn't find "${targetText}" on the page to highlight]`;
  } catch (err) {
    stopScribble?.();
    return `[couldn't highlight "${targetText}": ${err.message}]`;
  }
}

// Matches complete HIGHLIGHT directive lines (only ones already terminated
// by a real newline — an in-progress streamed line is left alone until its
// newline arrives), strips them from the displayed text, and reports any
// not-yet-seen targets via onNewTarget.
const HIGHLIGHT_LINE_RE = /^HIGHLIGHT:[ \t]*(.+)\n/gm;

function stripHighlightLines(rawText, seenTargets, onNewTarget) {
  HIGHLIGHT_LINE_RE.lastIndex = 0;
  let match;
  while ((match = HIGHLIGHT_LINE_RE.exec(rawText))) {
    const target = match[1].trim();
    if (target && !seenTargets.has(target)) {
      seenTargets.add(target);
      onNewTarget(target);
    }
  }
  return rawText.replace(HIGHLIGHT_LINE_RE, '');
}

async function refreshPageContextLabel() {
  try {
    const tab = await getActiveTab();
    if (!tab || !/^https?:/.test(tab.url || '')) {
      pageContextLabel.textContent = 'Include current page (no page open)';
      includePageCheckbox.disabled = true;
      return;
    }
    includePageCheckbox.disabled = highlightMode; // stays forced-on while in highlight mode
    const host = new URL(tab.url).hostname;
    pageContextLabel.textContent = `Include current page — ${tab.title || host} (${host})`;
  } catch {
    pageContextLabel.textContent = 'Include current page';
  }
}
refreshPageContextLabel();
setInterval(refreshPageContextLabel, 3000);
let pendingImages = []; // { mediaType, data (base64, no data: prefix) }

let promptHistory = [];
let historyIndex = 0; // 0..promptHistory.length-1 browses history; === promptHistory.length means back at the live draft
let historyDraft = '';

function isCaretOnFirstLine(el) {
  return el.value.slice(0, el.selectionStart).indexOf('\n') === -1;
}

function isCaretOnLastLine(el) {
  return el.value.slice(el.selectionEnd).indexOf('\n') === -1;
}

function setPromptValue(value) {
  promptInput.value = value;
  const pos = value.length;
  promptInput.setSelectionRange(pos, pos);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  pendingImages.forEach((img, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';

    const el = document.createElement('img');
    el.src = `data:${img.mediaType};base64,${img.data}`;
    thumb.appendChild(el);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove image';
    removeBtn.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    thumb.appendChild(removeBtn);

    attachmentsEl.appendChild(thumb);
  });
}

promptInput.addEventListener('paste', async (e) => {
  if (highlightMode) return; // no images while in highlight-search mode

  const items = e.clipboardData?.items;
  if (!items) return;

  const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
  if (imageItems.length === 0) return;

  e.preventDefault();
  for (const item of imageItems) {
    const blob = item.getAsFile();
    if (!blob) continue;
    const data = await blobToBase64(blob);
    pendingImages.push({ mediaType: blob.type, data });
  }
  renderAttachments();
});

async function checkHealth() {
  try {
    const res = await fetch(`${RELAY_URL}/health`);
    statusDot.className = res.ok ? 'dot online' : 'dot offline';
    if (res.ok) {
      const { busy } = await res.json();
      sendBtn.disabled = sending || busy;
    }
  } catch {
    statusDot.className = 'dot offline';
  }
}
checkHealth();
setInterval(checkHealth, 5000);

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function appendPlainText(container, text) {
  if (!text) return;
  container.appendChild(document.createTextNode(text));
}

function appendCodeBox(container, code, lang) {
  const box = document.createElement('div');
  box.className = 'code-box';

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  if (lang) codeEl.className = `language-${lang}`;
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  box.appendChild(pre);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.innerHTML = COPY_ICON;
  copyBtn.title = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1200);
    });
  });
  box.appendChild(copyBtn);

  container.appendChild(box);
}

// Renders fenced ```code``` blocks as copyable boxes, everything else as
// plain text. An unclosed fence (still streaming in) is left as literal
// text until its closing ``` arrives, then it re-renders as a box.
function renderRichText(container, rawText) {
  container.innerHTML = '';
  const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fenceRe.exec(rawText))) {
    appendPlainText(container, rawText.slice(lastIndex, match.index));
    appendCodeBox(container, match[2].replace(/\n$/, ''), match[1]);
    lastIndex = fenceRe.lastIndex;
  }
  appendPlainText(container, rawText.slice(lastIndex));
}

function appendBlock(role, text, images = []) {
  const wrapper = document.createElement('div');
  wrapper.className = `block ${role}`;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = role === 'you' ? 'You' : 'Claude Code';

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;

  wrapper.appendChild(label);
  wrapper.appendChild(body);

  if (images.length > 0) {
    const imagesRow = document.createElement('div');
    imagesRow.className = 'message-images';
    for (const img of images) {
      const el = document.createElement('img');
      el.src = `data:${img.mediaType};base64,${img.data}`;
      imagesRow.appendChild(el);
    }
    wrapper.appendChild(imagesRow);
  }

  output.appendChild(wrapper);
  output.scrollTop = output.scrollHeight;
  return body;
}

// Assistant response block has an extra "meta" line above the body for the
// busy spinner / thinking status / final token+timing summary.
function appendClaudeBlock() {
  const wrapper = document.createElement('div');
  wrapper.className = 'block claude';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Claude Code';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const body = document.createElement('div');
  body.className = 'body';

  wrapper.appendChild(label);
  wrapper.appendChild(meta);
  wrapper.appendChild(body);
  output.appendChild(wrapper);
  output.scrollTop = output.scrollHeight;
  return { meta, body };
}

function formatTokenCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function renderMeta(meta, { phase, thinkingTokens, elapsedMs }) {
  const elapsedS = (elapsedMs / 1000).toFixed(1);
  let label;
  if (phase === 'thinking') {
    label = `Thinking… ${elapsedS}s`;
    if (thinkingTokens) label += ` (~${thinkingTokens} tokens)`;
  } else if (phase === 'responding') {
    label = `Responding… ${elapsedS}s`;
  } else {
    label = `Waiting… ${elapsedS}s`;
  }
  meta.innerHTML = `<span class="spinner"></span><span>${label}</span>`;
}

async function sendPrompt() {
  const text = promptInput.value.trim();
  const images = pendingImages;
  if (!text && images.length === 0) return;

  // In highlight mode the box is shown/recorded as-typed, but what's
  // actually sent to Claude is wrapped as an explicit highlight request —
  // that's what triggers the HIGHLIGHT: directive handling below, and lets
  // the model reconcile loose phrasing against the real page text rather
  // than requiring an exact literal match.
  const wireText = highlightMode ? `Highlight "${text}" on this page.` : text;

  appendBlock('you', text || '(image)', images);
  promptInput.value = '';
  pendingImages = [];
  renderAttachments();

  if (text && promptHistory[promptHistory.length - 1] !== text) {
    promptHistory.push(text);
  }
  historyIndex = promptHistory.length;
  historyDraft = '';

  sending = true;
  sendBtn.disabled = true;

  const { meta: metaEl, body: responseEl } = appendClaudeBlock();

  const startTime = performance.now();
  let phase = 'requesting'; // requesting -> thinking -> responding -> done
  let thinkingTokens = 0;
  let rawText = '';
  const seenHighlights = new Set();

  renderMeta(metaEl, { phase, thinkingTokens, elapsedMs: 0 });
  const timer = setInterval(() => {
    renderMeta(metaEl, { phase, thinkingTokens, elapsedMs: performance.now() - startTime });
  }, 200);

  function refreshDisplay() {
    const displayText = stripHighlightLines(rawText, seenHighlights, (target) => {
      triggerHighlight(target).then((note) => {
        rawText += `\n\n${note}`;
        refreshDisplay();
      });
    });
    renderRichText(responseEl, displayText);
    output.scrollTop = output.scrollHeight;
  }

  function appendNote(note) {
    rawText += note;
    refreshDisplay();
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'thinking_start':
        phase = 'thinking';
        break;
      case 'thinking_tokens':
        thinkingTokens = event.estimatedTokens || thinkingTokens;
        break;
      case 'thinking_end':
        phase = 'responding';
        break;
      case 'text_delta':
        phase = 'responding';
        appendNote(event.text);
        break;
      case 'stderr':
        appendNote(`\n[stderr] ${event.text}`);
        break;
      case 'relayError':
        appendNote(`\n[relay error] ${event.message}`);
        break;
      case 'done': {
        // catch a final HIGHLIGHT line that never got a trailing newline
        rawText += '\n';
        refreshDisplay();
        const u = event.usage || {};
        const sentTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const replyTokens = u.output_tokens || 0;
        const thinkTokens = u.output_tokens_details?.thinking_tokens || 0;
        const seconds = ((event.durationMs || 0) / 1000).toFixed(1);
        const verb = thinkTokens > 0 ? 'Thought' : 'Responded';
        metaEl.textContent =
          `${verb} for ${seconds}s · sent ${formatTokenCount(sentTokens)} tokens · replied ${replyTokens} tokens`;
        phase = 'done';
        clearInterval(timer);
        break;
      }
      case 'closed':
        if (event.code !== 0 && event.code !== null) {
          appendNote(`\n\n[process exited with code ${event.code}]`);
        }
        break;
    }
  }

  try {
    let pageContext = null;
    if (includePageCheckbox.checked) {
      // getPageContext already validates the tab itself (returns null for
      // non-http pages) — .disabled isn't a reliable signal here, since
      // it's also used to lock the checkbox ON during highlight mode.
      pageContext = await getPageContext(await getActiveTab());
    }

    const res = await fetch(`${RELAY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wireText, images, pageContext }),
    });

    if (res.status === 409) {
      metaEl.textContent = '';
      responseEl.textContent = '[a prompt is already in progress — wait for it to finish before sending another]';
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => res.statusText);
      metaEl.textContent = '';
      responseEl.textContent = `[relay error] ${errText}`;
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = leftover + decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      leftover = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // partial or non-JSON line — skip
        }
      }
    }
  } catch (err) {
    appendNote(`\n[relay unreachable — is server.js running? ${err.message}]`);
  } finally {
    phase = 'done';
    clearInterval(timer);
    sending = false;
    checkHealth();
  }
}

sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
    return;
  }

  if (e.key === 'ArrowUp' && isCaretOnFirstLine(promptInput) && historyIndex > 0) {
    e.preventDefault();
    if (historyIndex === promptHistory.length) historyDraft = promptInput.value;
    historyIndex--;
    setPromptValue(promptHistory[historyIndex]);
    return;
  }

  if (e.key === 'ArrowDown' && isCaretOnLastLine(promptInput) && historyIndex < promptHistory.length) {
    e.preventDefault();
    historyIndex++;
    setPromptValue(historyIndex === promptHistory.length ? historyDraft : promptHistory[historyIndex]);
  }
});
