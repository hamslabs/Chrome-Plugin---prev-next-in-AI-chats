(() => {
  if (window.top !== window) return;

  const ANCHOR_Y = 96; // pixels below top; avoids fixed headers
  const HIGHLIGHT_MS = 900;
  const NAV_DEBOUNCE_MS = 450;
  let lastNavAt = 0;
  let lastSelectedEl = null;
  let lastSelectedAbsTop = null;

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
    if (!msg || msg.type !== 'PROMPT_NAVIGATE') return;
    if (msg.dir === 'next' || msg.dir === 'prev') navigate(msg.dir);
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
