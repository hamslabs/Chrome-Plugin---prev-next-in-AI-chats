(() => {
  if (window.top !== window) return;

  const ANCHOR_Y = 96; // pixels below top; avoids fixed headers
  const HIGHLIGHT_MS = 900;
  const NAV_DEBOUNCE_MS = 450;
  let lastNavAt = 0;
  let lastSelectedEl = null;
  let lastSelectedAbsTop = null;
  let outlineOpen = false;
  let outlineObserver = null;
  let outlineRefreshTimer = null;

  function showVersionBadge() {
    const shownKey = '__promptnav_version_badge_shown';
    if (sessionStorage.getItem(shownKey) === '1') return;
    sessionStorage.setItem(shownKey, '1');

    const manifest = chrome?.runtime?.getManifest?.();
    const version = manifest?.version || 'unknown';
    const id = '__promptnav_badge';
    if (document.getElementById(id)) return;

    const el = document.createElement('div');
    el.id = id;
    el.textContent = `Prompt Navigator v${version} loaded  (Opt+J next, Opt+K prev)`;
    el.style.position = 'fixed';
    el.style.top = '10px';
    el.style.right = '10px';
    el.style.zIndex = '2147483647';
    el.style.pointerEvents = 'none';
    el.style.padding = '8px 10px';
    el.style.borderRadius = '10px';
    el.style.border = '2px solid #ffb020';
    el.style.background = 'rgba(10,10,10,0.92)';
    el.style.color = '#fff';
    el.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace';
    el.style.boxShadow = '0 8px 28px rgba(0,0,0,0.35)';
    el.style.opacity = '0';
    el.style.transition = 'opacity 140ms ease-out';

    document.documentElement.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
    });

    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, 2200);

    // Also log to console for a second confirmation vector.
    // eslint-disable-next-line no-console
    console.info(`[Prompt Navigator] loaded v${version} on ${location.hostname}`);
  }

  showVersionBadge();

  function clampText(s, maxLen) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= maxLen) return t;
    return t.slice(0, Math.max(0, maxLen - 1)) + '…';
  }

  function getTextFromEl(el) {
    if (!el) return '';
    const t = el.innerText || el.textContent || '';
    return String(t).trim();
  }

  function uniqInDomOrder(nodes) {
    const seen = new Set();
    const out = [];
    for (const n of nodes) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  function qsa(sel, root = document) {
    try {
      return Array.from(root.querySelectorAll(sel));
    } catch {
      return [];
    }
  }

  function getUserPromptElements() {
    const host = location.hostname;

    // Site-specific selectors first (most stable wins).
    const siteSelectors = [];

    if (host === 'chat.openai.com' || host === 'chatgpt.com') {
      siteSelectors.push('[data-message-author-role="user"]');
      siteSelectors.push('article [data-message-author-role="user"]');
    }

    if (host === 'claude.ai') {
      siteSelectors.push('[data-testid="user-message"]');
      siteSelectors.push('[data-testid="message"][data-role="user"]');
    }

    if (host === 'gemini.google.com') {
      siteSelectors.push('user-query');
      siteSelectors.push('[data-test-id="user-query"]');
    }

    if (host === 'copilot.microsoft.com') {
      siteSelectors.push('[data-testid="user-message"]');
      siteSelectors.push('[data-author="user"]');
    }

    if (host === 'www.perplexity.ai') {
      siteSelectors.push('[data-testid="user-message"]');
      siteSelectors.push('[data-message-author="user"]');
    }

    // Generic fallbacks. Keep conservative to reduce false positives.
    const genericSelectors = [
      '[data-role="user"]',
      '[data-author="user"]',
      '[data-message-author-role="user"]',
      '[aria-label="You"]',
      '[data-testid*="user"]'
    ];

    const nodes = [];
    for (const sel of siteSelectors) nodes.push(...qsa(sel));

    // If site selectors found nothing, use generic fallbacks.
    if (nodes.length === 0) {
      for (const sel of genericSelectors) nodes.push(...qsa(sel));
    }

    // Filter out tiny or hidden nodes.
    const filtered = nodes.filter((el) => {
      if (!(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    });

    return uniqInDomOrder(filtered);
  }

  function getAssistantMessageElements() {
    const host = location.hostname;
    const siteSelectors = [];

    if (host === 'chat.openai.com' || host === 'chatgpt.com') {
      siteSelectors.push('[data-message-author-role="assistant"]');
      siteSelectors.push('article [data-message-author-role="assistant"]');
    }

    if (host === 'claude.ai') {
      siteSelectors.push('[data-testid="assistant-message"]');
      siteSelectors.push('[data-testid="assistant-message-content"]');
      siteSelectors.push('[data-testid="message"][data-role="assistant"]');
    }

    const genericSelectors = ['[data-role="assistant"]', '[data-author="assistant"]'];

    const nodes = [];
    for (const sel of siteSelectors) nodes.push(...qsa(sel));

    if (nodes.length === 0) {
      for (const sel of genericSelectors) nodes.push(...qsa(sel));
    }

    // Filter out tiny or hidden nodes.
    const filtered = nodes.filter((el) => {
      if (!(el instanceof Element)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    });

    return uniqInDomOrder(filtered);
  }

  function buildPromptGroups() {
    const users = getUserPromptElements();
    const assistants = getAssistantMessageElements();
    const all = [];
    for (const el of users) all.push({ el, role: 'user' });
    for (const el of assistants) all.push({ el, role: 'assistant' });

    all.sort((a, b) => {
      const at = absTop(a.el);
      const bt = absTop(b.el);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return compareDomOrder(a.el, b.el);
    });

    const groups = [];
    let cur = null;
    for (const m of all) {
      if (m.role === 'user') {
        cur = { userEl: m.el, assistants: [] };
        groups.push(cur);
      } else if (cur) {
        cur.assistants.push(m.el);
      }
    }
    return groups;
  }

  function ensureOutlineStyles() {
    const id = '__promptnav_outline_style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
#__promptnav_outline {
  --pn-bg: rgba(14, 14, 16, 0.94);
  --pn-fg: #f3f4f6;
  --pn-dim: rgba(255,255,255,0.70);
  --pn-accent: #ffb020;
  --pn-border: rgba(255,255,255,0.12);
  position: sticky;
  top: 8px;
  margin: 8px;
  width: auto;
  max-height: min(60vh, 560px);
  z-index: 9999;
  color: var(--pn-fg);
  background: var(--pn-bg);
  border: 1px solid var(--pn-border);
  border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0,0,0,0.45);
  overflow: hidden;
}

#__promptnav_outline.__pn_fixed {
  position: fixed;
  top: 12px;
  right: 12px;
  width: min(420px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  z-index: 2147483647;
  margin: 0;
}

#__promptnav_outline * { box-sizing: border-box; }
#__promptnav_outline header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--pn-border);
}
#__promptnav_outline header .title {
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--pn-dim);
}
#__promptnav_outline header .btns { display: flex; gap: 8px; }
#__promptnav_outline button {
  appearance: none;
  border: 1px solid var(--pn-border);
  background: rgba(255,255,255,0.06);
  color: var(--pn-fg);
  border-radius: 10px;
  padding: 6px 10px;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  cursor: pointer;
}
#__promptnav_outline button:hover { border-color: rgba(255,255,255,0.24); }
#__promptnav_outline button.primary { border-color: rgba(255,176,32,0.55); }
#__promptnav_outline button.primary:hover { border-color: rgba(255,176,32,0.9); }
#__promptnav_outline .body {
  padding: 10px 10px 12px;
  overflow: auto;
  max-height: calc(min(60vh, 560px) - 46px);
}
#__promptnav_outline details {
  border: 1px solid var(--pn-border);
  border-radius: 12px;
  background: rgba(255,255,255,0.04);
  margin: 8px 0;
  overflow: hidden;
}
#__promptnav_outline summary {
  list-style: none;
  cursor: pointer;
  padding: 10px 10px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
#__promptnav_outline summary::-webkit-details-marker { display: none; }
#__promptnav_outline .idx {
  min-width: 2.2em;
  color: var(--pn-accent);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
#__promptnav_outline .sumtxt {
  flex: 1;
  color: var(--pn-fg);
  font: 13px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  line-height: 1.25;
  word-break: break-word;
}
#__promptnav_outline .content {
  border-top: 1px solid var(--pn-border);
  padding: 10px;
}
#__promptnav_outline pre {
  margin: 0 0 10px 0;
  padding: 10px;
  border: 1px solid var(--pn-border);
  border-radius: 10px;
  background: rgba(0,0,0,0.25);
  color: var(--pn-fg);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
#__promptnav_outline .row { display: flex; gap: 8px; flex-wrap: wrap; }
#__promptnav_outline .meta {
  margin-top: 8px;
  color: var(--pn-dim);
  font: 11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
`;
    document.documentElement.appendChild(style);
  }

  function scheduleOutlineRefresh() {
    if (!outlineOpen) return;
    if (outlineRefreshTimer) clearTimeout(outlineRefreshTimer);
    outlineRefreshTimer = setTimeout(() => {
      outlineRefreshTimer = null;
      renderOutline();
    }, 450);
  }

  function startOutlineObserver() {
    if (outlineObserver) return;
    outlineObserver = new MutationObserver(() => scheduleOutlineRefresh());
    outlineObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopOutlineObserver() {
    if (!outlineObserver) return;
    outlineObserver.disconnect();
    outlineObserver = null;
  }

  function setAllDetails(open) {
    const panel = document.getElementById('__promptnav_outline');
    if (!panel) return;
    for (const d of panel.querySelectorAll('details')) d.open = open;
  }

  function renderOutline() {
    const panel = document.getElementById('__promptnav_outline');
    if (!panel) return;
    const body = panel.querySelector('.body');
    if (!body) return;

    const groups = buildPromptGroups();
    body.textContent = '';

    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'meta';
      empty.textContent = 'No prompts found in the current DOM. Scroll a bit, then press Refresh.';
      body.appendChild(empty);
      return;
    }

    let i = 0;
    for (const g of groups) {
      i++;
      const userText = getTextFromEl(g.userEl);
      const summaryText = clampText(userText, 140) || '(empty prompt)';

      const d = document.createElement('details');
      const s = document.createElement('summary');

      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = String(i).padStart(2, '0');

      const sum = document.createElement('div');
      sum.className = 'sumtxt';
      sum.textContent = summaryText;

      s.appendChild(idx);
      s.appendChild(sum);
      d.appendChild(s);

      const content = document.createElement('div');
      content.className = 'content';

      const pre = document.createElement('pre');
      pre.textContent = userText || '';
      content.appendChild(pre);

      const row = document.createElement('div');
      row.className = 'row';

      const jump = document.createElement('button');
      jump.className = 'primary';
      jump.textContent = 'Jump';
      jump.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        scrollToEl(g.userEl);
      });

      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(userText || '');
        } catch {
          // ignore
        }
      });

      row.appendChild(jump);
      row.appendChild(copy);
      content.appendChild(row);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${g.assistants.length} assistant block(s) currently in DOM`;
      content.appendChild(meta);

      d.appendChild(content);
      body.appendChild(d);
    }
  }

  function isScrollableY(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return false;
    return el.scrollHeight - el.clientHeight > 200;
  }

  function findScrollableAncestor(startEl) {
    let el = startEl;
    for (let i = 0; i < 25 && el; i++) {
      if (isScrollableY(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findTranscriptRoot() {
    const anchors = [];
    anchors.push(...getUserPromptElements().slice(0, 6));
    anchors.push(...getAssistantMessageElements().slice(0, 6));

    const counts = new Map();
    for (const a of anchors) {
      const scroller = findScrollableAncestor(a);
      if (!scroller) continue;
      counts.set(scroller, (counts.get(scroller) || 0) + 1);
    }

    let best = null;
    let bestCount = 0;
    for (const [el, c] of counts.entries()) {
      if (c > bestCount) {
        best = el;
        bestCount = c;
      }
    }

    // Fallback to main content container; if it's not scrollable, we'll use fixed.
    return best || document.querySelector('main') || document.body;
  }

  function openOutline() {
    ensureOutlineStyles();
    let panel = document.getElementById('__promptnav_outline');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = '__promptnav_outline';

      const header = document.createElement('header');
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = 'Prompt Outline';

      const btns = document.createElement('div');
      btns.className = 'btns';

      const refresh = document.createElement('button');
      refresh.textContent = 'Refresh';
      refresh.addEventListener('click', () => renderOutline());

      const expandAll = document.createElement('button');
      expandAll.textContent = 'Expand';
      expandAll.addEventListener('click', () => setAllDetails(true));

      const collapseAll = document.createElement('button');
      collapseAll.textContent = 'Collapse';
      collapseAll.addEventListener('click', () => setAllDetails(false));

      const close = document.createElement('button');
      close.textContent = 'Close';
      close.addEventListener('click', () => closeOutline());

      btns.appendChild(refresh);
      btns.appendChild(expandAll);
      btns.appendChild(collapseAll);
      btns.appendChild(close);

      header.appendChild(title);
      header.appendChild(btns);
      panel.appendChild(header);

      const body = document.createElement('div');
      body.className = 'body';
      panel.appendChild(body);
    }

    const root = findTranscriptRoot();
    if (root && isScrollableY(root)) {
      panel.classList.remove('__pn_fixed');
      if (panel.parentElement !== root) {
        root.insertBefore(panel, root.firstChild);
      }
    } else {
      panel.classList.add('__pn_fixed');
      if (panel.parentElement !== document.documentElement) {
        document.documentElement.appendChild(panel);
      }
    }

    outlineOpen = true;
    startOutlineObserver();
    renderOutline();
  }

  function closeOutline() {
    outlineOpen = false;
    stopOutlineObserver();
    const panel = document.getElementById('__promptnav_outline');
    if (panel) panel.remove();
  }

  function toggleOutline() {
    if (outlineOpen) closeOutline();
    else openOutline();
  }

  function absTop(el) {
    const r = el.getBoundingClientRect();
    return r.top + window.scrollY;
  }

  function compareDomOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function sortByVisualTop(els) {
    els.sort((a, b) => {
      const at = absTop(a);
      const bt = absTop(b);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return compareDomOrder(a, b);
    });
    return els;
  }

  function nearestIndexByAbsTop(els, targetTop) {
    if (!Number.isFinite(targetTop) || els.length === 0) return -1;
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < els.length; i++) {
      const d = Math.abs(absTop(els[i]) - targetTop);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return bestI;
  }

  function getNextIndex(els, dir) {
    if (els.length === 0) return -1;

    const anchor = window.scrollY + ANCHOR_Y;
    const tops = els.map((el) => absTop(el));

    if (dir === 'next') {
      // First element clearly below the anchor line.
      const i = tops.findIndex((t) => t > anchor + 8);
      return i === -1 ? els.length - 1 : i;
    }

    // dir === 'prev': last element clearly above the anchor line.
    for (let i = tops.length - 1; i >= 0; i--) {
      if (tops[i] < anchor - 8) return i;
    }
    return 0;
  }

  function highlight(el) {
    const prev = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #ffb020';
    el.style.outlineOffset = '4px';
    setTimeout(() => {
      el.style.outline = prev;
      el.style.outlineOffset = prevOffset;
    }, HIGHLIGHT_MS);
  }

  function scrollToEl(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
    // Adjust after scrollIntoView to account for sticky headers.
    setTimeout(() => {
      window.scrollBy({ top: -ANCHOR_Y, left: 0, behavior: 'auto' });
    }, 0);
    highlight(el);
  }

  function navigate(dir) {
    const now = Date.now();
    if (now - lastNavAt < NAV_DEBOUNCE_MS) return;
    lastNavAt = now;

    const els = sortByVisualTop(getUserPromptElements());
    if (els.length === 0) return;

    // Prefer index-based navigation once a prompt has been selected; this avoids
    // getting "stuck" when the viewport anchor line is inside the selected prompt,
    // and is more reliable during smooth scrolling.
    let curIdx = -1;
    if (lastSelectedEl) curIdx = els.indexOf(lastSelectedEl);
    if (curIdx === -1 && Number.isFinite(lastSelectedAbsTop)) {
      curIdx = nearestIndexByAbsTop(els, lastSelectedAbsTop);
    }

    let idx;
    if (curIdx !== -1) {
      idx = dir === 'next' ? Math.min(curIdx + 1, els.length - 1) : Math.max(curIdx - 1, 0);
    } else {
      idx = getNextIndex(els, dir);
      if (idx === -1) return;
    }

    lastSelectedEl = els[idx];
    lastSelectedAbsTop = absTop(els[idx]);
    scrollToEl(els[idx]);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'PROMPT_NAVIGATE') {
      if (msg.dir === 'next' || msg.dir === 'prev') navigate(msg.dir);
    } else if (msg.type === 'PROMPT_OUTLINE_TOGGLE') {
      toggleOutline();
    }
  });

  // Fallback for cases where the browser doesn't dispatch the extension command
  // (or a shortcut is unassigned). On macOS, Option+P produces "π" in inputs, so
  // we preventDefault when we recognize our shortcuts.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

      const k = (e.key || '').toLowerCase();
      if (k !== 'j' && k !== 'k') return;

      e.preventDefault();
      e.stopPropagation();
      navigate(k === 'j' ? 'next' : 'prev');
    },
    true
  );
})();
