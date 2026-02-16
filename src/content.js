(() => {
  if (window.top !== window) return;

  const ANCHOR_Y = 96; // pixels below top; avoids fixed headers
  const HIGHLIGHT_MS = 900;
  const NAV_DEBOUNCE_MS = 450;
  let lastNavAt = 0;
  let lastSelectedEl = null;
  let lastSelectedAbsTop = null;
  function safeSessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeSessionSet(key, val) {
    try {
      sessionStorage.setItem(key, val);
    } catch {
      // ignore
    }
  }

  function currentHost() {
    // Test harness can force a host without requiring a real navigation.
    if (globalThis.__promptnav_test_host) return String(globalThis.__promptnav_test_host);
    return location.hostname;
  }

  function chromeRuntime() {
    // Normal extension path: `chrome.runtime`.
    // Test harness path: `globalThis.__promptnav_test_chrome_runtime`.
    try {
      return chrome?.runtime || globalThis.__promptnav_test_chrome_runtime || null;
    } catch {
      return globalThis.__promptnav_test_chrome_runtime || null;
    }
  }

  let groupedViewEnabled = safeSessionGet('__promptnav_grouped_view') === '1';
  let groupedActiveUserEl = null; // null means "all assistant blocks collapsed"
  let lastGroupedBtnToggleAt = 0;
  let outlineOpen = false;
  let outlineObserver = null;
  let outlineRefreshTimer = null;
  let collapseEnhanceTimer = null;
  let collapseObserver = null;
  let groupedObserver = null;
  let groupedRefreshTimer = null;
  let groupedBtnListening = false;
  let groupedOpSeq = 0;
  let busyDelayTimer = null;

  function showToast(text, ms = 1200) {
    const id = '__promptnav_toast';
    const prev = document.getElementById(id);
    if (prev) prev.remove();

    const el = document.createElement('div');
    el.id = id;
    el.textContent = String(text || '');
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
    el.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
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
    }, Math.max(250, ms));
  }

  function ensureBusyStyles() {
    const id = '__promptnav_busy_style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
#__promptnav_busy {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483647;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 11px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.26);
  background: rgba(10,10,10,0.88);
  color: #fff;
  box-shadow: 0 8px 28px rgba(0,0,0,0.35);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
#__promptnav_busy .ball {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: conic-gradient(#ff4d4f, #ffd666, #95de64, #40a9ff, #b37feb, #ff4d4f);
  animation: __pn_spin 700ms linear infinite;
}
@keyframes __pn_spin { to { transform: rotate(360deg); } }
`;
    document.documentElement.appendChild(style);
  }

  function showBusy(text) {
    ensureBusyStyles();
    const id = '__promptnav_busy';
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      const ball = document.createElement('div');
      ball.className = 'ball';
      const label = document.createElement('div');
      label.className = 'txt';
      el.appendChild(ball);
      el.appendChild(label);
      document.documentElement.appendChild(el);
    }
    const txt = el.querySelector('.txt');
    if (txt) txt.textContent = String(text || 'Working…');
  }

  function hideBusy() {
    const el = document.getElementById('__promptnav_busy');
    if (el) el.remove();
  }

  function waitTick(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function setAssistantHiddenBatch(nodes, hidden, opSeq) {
    const list = Array.from(nodes || []).filter((n) => n instanceof HTMLElement);
    const CHUNK = 120;
    for (let i = 0; i < list.length; i += CHUNK) {
      if (opSeq !== groupedOpSeq) return false;
      for (let j = i; j < Math.min(i + CHUNK, list.length); j++) {
        setAssistantHiddenForGroupedView(list[j], hidden);
      }
      if (i + CHUNK < list.length) await waitTick(0);
    }
    return true;
  }

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

  function isHeadingEl(el) {
    if (!(el instanceof Element)) return false;
    return /^H[1-6]$/i.test(el.tagName);
  }

  function headingLevel(el) {
    if (!isHeadingEl(el)) return 0;
    const m = /H([1-6])/i.exec(el.tagName);
    return m ? Number(m[1]) : 0;
  }

  function collapsibleNodesForHeading(h) {
    const lvl = headingLevel(h);
    if (!lvl) return [];
    const out = [];
    let el = h.nextElementSibling;
    while (el) {
      if (isHeadingEl(el) && headingLevel(el) <= lvl) break;
      out.push(el);
      el = el.nextElementSibling;
    }
    return out;
  }

  function setHeadingCollapsed(h, collapsed) {
    const nodes = collapsibleNodesForHeading(h);
    for (const n of nodes) n.hidden = collapsed;
    h.dataset.pnCollapsed = collapsed ? '1' : '0';

    const btn = h.querySelector(':scope > button.__pn_collapse_btn');
    if (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.textContent = collapsed ? '▸' : '▾';
    }
  }

  function getCollapsibleHeadings() {
    const headings = [];
    for (const msg of assistantMessageRoots()) {
      headings.push(...msg.querySelectorAll('h1[data-pn-collapsible=\"1\"],h2[data-pn-collapsible=\"1\"],h3[data-pn-collapsible=\"1\"],h4[data-pn-collapsible=\"1\"],h5[data-pn-collapsible=\"1\"],h6[data-pn-collapsible=\"1\"]'));
    }
    return headings.filter((h) => h instanceof HTMLElement);
  }

  function toggleCollapseAllHeadings() {
    // Ensure toggles exist before we try to collapse/expand.
    scheduleCollapseEnhance();

    const hs = getCollapsibleHeadings();
    if (hs.length === 0) return;

    const anyExpanded = hs.some((h) => h.dataset.pnCollapsed !== '1');
    const nextCollapsed = anyExpanded; // if anything is expanded, collapse all; else expand all
    for (const h of hs) setHeadingCollapsed(h, nextCollapsed);
  }

  function enhanceCollapsibleHeadingsInAssistantMessage(msgEl) {
    if (!(msgEl instanceof Element)) return;
    if (msgEl.querySelector('#__promptnav_outline')) return;

    const headings = Array.from(msgEl.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    for (const h of headings) {
      if (!(h instanceof HTMLElement)) continue;
      if (h.closest('#__promptnav_outline')) continue;
      if (h.dataset.pnCollapsible === '1') continue;

      // Only collapse headings that have at least one sibling after them.
      // This avoids adding toggles to headings used purely as labels.
      if (!h.nextElementSibling) continue;

      const btn = document.createElement('button');
      btn.className = '__pn_collapse_btn';
      btn.type = 'button';
      btn.textContent = '▾';
      btn.setAttribute('aria-label', 'Collapse/expand section');
      btn.setAttribute('aria-expanded', 'true');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const collapsed = h.dataset.pnCollapsed === '1';
        setHeadingCollapsed(h, !collapsed);
      });

      // Insert at the beginning of the heading. Keep the heading text selectable.
      h.insertBefore(btn, h.firstChild);
      h.dataset.pnCollapsible = '1';
      h.dataset.pnCollapsed = '0';
    }
  }

  function assistantMessageRoots() {
    const host = currentHost();
    if (host === 'chat.openai.com' || host === 'chatgpt.com') {
      return qsa('[data-message-author-role="assistant"]');
    }
    if (host === 'claude.ai') {
      // Claude markup is less stable; we try the likely containers.
      return uniqInDomOrder([
        ...qsa('[data-testid="assistant-message"]'),
        ...qsa('[data-testid="assistant-message-content"]'),
        ...qsa('[data-testid="message"][data-role="assistant"]')
      ]);
    }
    return [];
  }

  function scheduleCollapseEnhance() {
    if (collapseEnhanceTimer) clearTimeout(collapseEnhanceTimer);
    collapseEnhanceTimer = setTimeout(() => {
      collapseEnhanceTimer = null;
      for (const msg of assistantMessageRoots()) enhanceCollapsibleHeadingsInAssistantMessage(msg);
    }, 250);
  }

  function startCollapseObserver() {
    if (collapseObserver) return;
    collapseObserver = new MutationObserver(() => scheduleCollapseEnhance());
    collapseObserver.observe(document.body, { childList: true, subtree: true });
  }

  function ensureCollapseStyles() {
    const id = '__promptnav_collapse_style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
button.__pn_collapse_btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0 8px 0 0;
  margin: 0;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  cursor: pointer;
  vertical-align: baseline;
  opacity: 0.8;
}
button.__pn_collapse_btn:hover { opacity: 1; }
`;
    document.documentElement.appendChild(style);
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

  function chatgptTurnElements() {
    // ChatGPT frequently changes test IDs. Prefer explicit conversation-turn IDs,
    // but tolerate prefix/contains variants.
    const candidates = uniqInDomOrder([
      ...qsa('article[data-testid="conversation-turn"]'),
      ...qsa('article[data-testid^="conversation-turn"]'),
      ...qsa('article[data-testid*="conversation-turn"]'),
      ...qsa('[data-testid="conversation-turn"]'),
      ...qsa('[data-testid^="conversation-turn"]'),
      ...qsa('[data-testid*="conversation-turn"]')
    ]);
    // Keep only containers that look like a single user/assistant turn.
    return candidates.filter((el) => {
      if (!(el instanceof Element)) return false;
      const hasRoleNode =
        !!el.querySelector('[data-message-author-role="assistant"]') ||
        !!el.querySelector('[data-message-author-role="user"]');
      // Fallback: some variants expose a role-ish marker on descendants.
      const hasLikelyRole =
        !!el.querySelector('[data-author="assistant"],[data-author="user"],[data-role="assistant"],[data-role="user"]');
      return hasRoleNode || hasLikelyRole;
    });
  }

  function chatgptRoleForTurn(turnEl) {
    if (!(turnEl instanceof Element)) return null;
    if (turnEl.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
    if (turnEl.querySelector('[data-message-author-role="user"]')) return 'user';
    return null;
  }

  function getUserPromptElements() {
    const host = currentHost();

    // Site-specific selectors first (most stable wins).
    const siteSelectors = [];

    if (host === 'chat.openai.com' || host === 'chatgpt.com') {
      const turns = chatgptTurnElements();
      if (turns.length) {
        return turns.filter((t) => chatgptRoleForTurn(t) === 'user');
      }
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
      // If we injected grouped buttons onto this node, keep it even if layout is odd.
      if (el instanceof HTMLElement && el.dataset.pnUserPrompt === '1') return true;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    });

    return uniqInDomOrder(filtered);
  }

  function getAssistantMessageElements() {
    const host = currentHost();
    const siteSelectors = [];

    if (host === 'chat.openai.com' || host === 'chatgpt.com') {
      const turns = chatgptTurnElements();
      if (turns.length) {
        return turns.filter((t) => chatgptRoleForTurn(t) === 'assistant');
      }
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
      // In grouped view we hide assistant blocks via inline display:none; keep those
      // nodes so we can restore them on expand.
      if (el instanceof HTMLElement && el.dataset.pnGroupedHidden === '1') return true;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 16) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      return true;
    });

    return uniqInDomOrder(filtered);
  }

  function isLayoutHiddenForGrouping(el) {
    if (!(el instanceof Element)) return true;
    if (el instanceof HTMLElement && el.dataset.pnGroupedHidden === '1') return true;
    try {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
    } catch {
      // ignore
    }
    // display:none often yields a 0x0 rect; treat that as "hidden for layout".
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  }

  function buildPromptGroups() {
    // Build groups by DOM ranges:
    // each user's group owns assistant nodes that appear after it and before
    // the next user node. This is robust even when assistants are display:none.
    const users = uniqInDomOrder(getUserPromptElements());
    const assistants = uniqInDomOrder(getAssistantMessageElements());
    if (users.length === 0) return [];

    const groups = users.map((u) => ({ userEl: u, assistants: [] }));

    function isAfter(a, b) {
      if (!a || !b || a === b) return false;
      return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING);
    }

    function isBefore(a, b) {
      if (!a || !b || a === b) return false;
      return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    for (let i = 0; i < groups.length; i++) {
      const curUser = groups[i].userEl;
      const nextUser = i + 1 < groups.length ? groups[i + 1].userEl : null;
      for (const a of assistants) {
        if (!isAfter(a, curUser)) continue;
        if (nextUser && !isBefore(a, nextUser)) continue;
        groups[i].assistants.push(a);
      }
    }

    return groups;
  }

  function setAssistantHiddenForGroupedView(el, hidden) {
    if (!(el instanceof HTMLElement)) return;
    if (hidden) {
      // Only mark elements we actually hide so we can safely restore on disable.
      if (el.dataset.pnGroupedHidden !== '1') {
        // `hidden` can be overridden by site CSS (`display: ... !important`), so
        // force-hide via inline `display:none !important`.
        el.dataset.pnGroupedHidden = '1';
        el.dataset.pnGroupedPrevDisplay = el.style.display || '__empty__';
        el.style.setProperty('display', 'none', 'important');
      }
      return;
    }

    // Only unhide elements we previously hid.
    if (el.dataset.pnGroupedHidden === '1') {
      const prev = el.dataset.pnGroupedPrevDisplay;
      delete el.dataset.pnGroupedPrevDisplay;
      // Don't accidentally restore to `display:none`.
      if (prev && prev !== '__empty__' && prev !== 'none') el.style.display = prev;
      else el.style.removeProperty('display');
      delete el.dataset.pnGroupedHidden;
    }
  }

  function scheduleGroupedRefresh() {
    if (!groupedViewEnabled) return;
    if (groupedRefreshTimer) clearTimeout(groupedRefreshTimer);
    groupedRefreshTimer = setTimeout(() => {
      groupedRefreshTimer = null;
      if (!groupedViewEnabled) return;
      // Keep any newly-added assistant blocks collapsed unless they belong to
      // the currently selected prompt group.
      applyGroupedViewState({ preferCurrent: true });
    }, 300);
  }

  function startGroupedObserver() {
    if (groupedObserver) return;
    groupedObserver = new MutationObserver(() => scheduleGroupedRefresh());
    groupedObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopGroupedObserver() {
    if (!groupedObserver) return;
    groupedObserver.disconnect();
    groupedObserver = null;
  }

  function applyGroupedViewState({ preferCurrent }) {
    const groups = buildPromptGroups();
    if (groups.length === 0) return;

    // Determine which prompt is "active" for expansion.
    let activeUserEl = groupedActiveUserEl;
    if (!activeUserEl && preferCurrent && lastSelectedEl && lastSelectedEl instanceof Element) {
      activeUserEl = lastSelectedEl;
    }
    // If no active prompt, keep everything collapsed.

    for (const g of groups) {
      // Mark prompts so we can find them later for cleanup.
      if (g.userEl && g.userEl instanceof HTMLElement) {
        g.userEl.dataset.pnUserPrompt = '1';
        if (g.assistants.length > 0) ensureGroupedToggleButton(g.userEl);
        else removeGroupedToggleButton(g.userEl);
      }
      const isActive = activeUserEl && g.userEl === activeUserEl;
      for (const a of g.assistants) setAssistantHiddenForGroupedView(a, !isActive);
      if (g.userEl && g.userEl instanceof HTMLElement) updateGroupedToggleButtonState(g.userEl, !!isActive);
    }
  }

  function clearGroupedPromptMarkers() {
    for (const el of qsa('[data-pn-user-prompt="1"]')) {
      if (!(el instanceof HTMLElement)) continue;
      delete el.dataset.pnUserPrompt;
    }
  }

  function ensureGroupedViewStyles() {
    const id = '__promptnav_grouped_style';
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
button.__pn_group_btn {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 6;
  pointer-events: auto;
  appearance: none;
  border: 1px solid rgba(255,255,255,0.35);
  background: rgba(0,0,0,0.62);
  color: rgba(255,255,255,0.98);
  border-radius: 999px;
  padding: 4px 10px;
  min-width: 30px;
  text-align: center;
  line-height: 1;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  cursor: pointer;
  user-select: none;
  opacity: 0.92;
}
button.__pn_group_btn:hover { opacity: 1; border-color: rgba(255,255,255,0.5); }
button.__pn_group_btn.__pn_open { border-color: rgba(255,176,32,0.55); }
button.__pn_group_btn.__pn_open:hover { border-color: rgba(255,176,32,0.9); }
`;
    document.documentElement.appendChild(style);
  }

  function ensureGroupedToggleButton(promptEl) {
    if (!(promptEl instanceof HTMLElement)) return;
    ensureGroupedViewStyles();

    let btn = promptEl.querySelector(':scope > button.__pn_group_btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.className = '__pn_group_btn';
      btn.type = 'button';
      btn.dataset.pnDirectHandler = '1';
      btn.textContent = '▸';
      btn.setAttribute('aria-label', 'Expand/collapse this prompt response');
      // Attach a direct handler and also keep the document-level capture handler as a
      // fallback for UIs that intercept events. toggleGroupedPrompt() de-dupes rapid calls.
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleGroupedPrompt(promptEl);
      });

      const pos = getComputedStyle(promptEl).position;
      if (pos === 'static') {
        // Give the button an anchor without perturbing elements that already opt in.
        promptEl.dataset.pnGroupedRelPos = '1';
        promptEl.dataset.pnGroupedOrigPos = promptEl.style.position || '__empty__';
        promptEl.style.position = 'relative';
      }

      // Reserve space so the button doesn't overlap prompt text.
      try {
        const pr = Number.parseFloat(getComputedStyle(promptEl).paddingRight || '0') || 0;
        const minPad = 56; // enough for button + breathing room
        if (pr < minPad) {
          promptEl.dataset.pnGroupedPadRight = '1';
          promptEl.dataset.pnGroupedOrigPadRight = promptEl.style.paddingRight || '__empty__';
          promptEl.style.paddingRight = `${minPad}px`;
        }
      } catch {
        // ignore
      }

      promptEl.appendChild(btn);
    }
  }

  function removeGroupedToggleButton(promptEl) {
    if (!(promptEl instanceof HTMLElement)) return;
    const btn = promptEl.querySelector(':scope > button.__pn_group_btn');
    if (btn) btn.remove();

    if (promptEl.dataset.pnGroupedRelPos === '1') {
      delete promptEl.dataset.pnGroupedRelPos;
      const origPos = promptEl.dataset.pnGroupedOrigPos;
      delete promptEl.dataset.pnGroupedOrigPos;
      promptEl.style.position = origPos && origPos !== '__empty__' ? origPos : '';
    }

    if (promptEl.dataset.pnGroupedPadRight === '1') {
      delete promptEl.dataset.pnGroupedPadRight;
      const origPad = promptEl.dataset.pnGroupedOrigPadRight;
      delete promptEl.dataset.pnGroupedOrigPadRight;
      promptEl.style.paddingRight = origPad && origPad !== '__empty__' ? origPad : '';
    }
  }

  function updateGroupedToggleButtonState(promptEl, isOpen) {
    if (!(promptEl instanceof HTMLElement)) return;
    const btn = promptEl.querySelector(':scope > button.__pn_group_btn');
    if (!(btn instanceof HTMLButtonElement)) return;
    btn.textContent = isOpen ? '▾' : '▸';
    btn.classList.toggle('__pn_open', !!isOpen);
  }

  function clearGroupedToggleButtons() {
    for (const btn of qsa('button.__pn_group_btn')) {
      if (!(btn instanceof HTMLButtonElement)) continue;
      btn.remove();
    }
    for (const el of qsa('[data-pn-grouped-rel-pos="1"]')) {
      if (!(el instanceof HTMLElement)) continue;
      delete el.dataset.pnGroupedRelPos;
      const orig = el.dataset.pnGroupedOrigPos;
      delete el.dataset.pnGroupedOrigPos;
      el.style.position = orig && orig !== '__empty__' ? orig : '';
    }
    for (const el of qsa('[data-pn-grouped-pad-right="1"]')) {
      if (!(el instanceof HTMLElement)) continue;
      delete el.dataset.pnGroupedPadRight;
      const orig = el.dataset.pnGroupedOrigPadRight;
      delete el.dataset.pnGroupedOrigPadRight;
      el.style.paddingRight = orig && orig !== '__empty__' ? orig : '';
    }
  }

  function toggleGroupedPrompt(promptEl) {
    if (!groupedViewEnabled) return;
    if (!(promptEl instanceof HTMLElement)) return;
    const now = Date.now();
    if (now - lastGroupedBtnToggleAt < 120) return;
    lastGroupedBtnToggleAt = now;

    const groups = buildPromptGroups();
    const g = groups.find((x) => x.userEl === promptEl);
    if (!g) return;
    if (!g.assistants || g.assistants.length === 0) return;

    const anyVisible = g.assistants.some((a) => a instanceof HTMLElement && a.dataset.pnGroupedHidden !== '1');
    if (groupedActiveUserEl === promptEl && anyVisible) {
      groupedActiveUserEl = null;
      // Keep all groups collapsed after a manual collapse toggle; otherwise
      // the refresh path may immediately re-open the last selected prompt.
      lastSelectedEl = null;
      lastSelectedAbsTop = null;
      for (const gg of groups) for (const a of gg.assistants) setAssistantHiddenForGroupedView(a, true);
      // Update button states for currently-known prompts.
      for (const gg of groups) if (gg.userEl instanceof HTMLElement) updateGroupedToggleButtonState(gg.userEl, false);
      return;
    }

    groupedActiveUserEl = promptEl;
    lastSelectedEl = promptEl;
    lastSelectedAbsTop = absTop(promptEl);
    applyGroupedViewState({ preferCurrent: true });
  }

  function handleGroupedBtnEvent(e) {
    if (!groupedViewEnabled) return;
    if (e.type !== 'click') return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest('button.__pn_group_btn');
    if (!btn) return;
    // Prefer direct button handler when present to avoid double toggles.
    if (btn instanceof HTMLElement && btn.dataset.pnDirectHandler === '1') return;

    e.preventDefault();
    e.stopPropagation();

    const promptEl = btn.closest('[data-pn-user-prompt="1"]');
    if (!(promptEl instanceof HTMLElement)) return;
    toggleGroupedPrompt(promptEl);
  }

  function startGroupedBtnListener() {
    if (groupedBtnListening) return;
    groupedBtnListening = true;
    document.addEventListener('click', handleGroupedBtnEvent, true);
  }

  function stopGroupedBtnListener() {
    if (!groupedBtnListening) return;
    groupedBtnListening = false;
    document.removeEventListener('click', handleGroupedBtnEvent, true);
  }

  async function setGroupedViewEnabled(enabled) {
    const opSeq = ++groupedOpSeq;
    groupedViewEnabled = !!enabled;
    safeSessionSet('__promptnav_grouped_view', groupedViewEnabled ? '1' : '0');
    const busyLabel = groupedViewEnabled ? 'Collapsing responses…' : 'Restoring responses…';
    if (busyDelayTimer) clearTimeout(busyDelayTimer);
    busyDelayTimer = setTimeout(() => {
      if (opSeq !== groupedOpSeq) return;
      showBusy(busyLabel);
    }, 120);

    try {
      if (groupedViewEnabled) {
        startGroupedObserver();
        startGroupedBtnListener();
        // Collapse everything. We'll expand a group only when you select one (click the button or navigate).
        const ok = await setAssistantHiddenBatch(getAssistantMessageElements(), true, opSeq);
        if (!ok || opSeq !== groupedOpSeq) return;
        groupedActiveUserEl = null;
        applyGroupedViewState({ preferCurrent: false });
        showToast('Grouped view: ON');
      } else {
        if (groupedRefreshTimer) {
          clearTimeout(groupedRefreshTimer);
          groupedRefreshTimer = null;
        }
        // Preserve scroll position around the currently expanded response (if any).
        let anchorEl = null;
        try {
          if (groupedActiveUserEl && groupedActiveUserEl instanceof Element) {
            const groups = buildPromptGroups();
            const g = groups.find((x) => x.userEl === groupedActiveUserEl);
            anchorEl = (g && g.assistants && g.assistants[0]) || groupedActiveUserEl;
          } else if (lastSelectedEl && lastSelectedEl instanceof Element) {
            anchorEl = lastSelectedEl;
          }
        } catch {
          // ignore
        }
        const anchorTopBefore = anchorEl ? anchorEl.getBoundingClientRect().top : null;

        stopGroupedObserver();
        stopGroupedBtnListener();
        // Only unhide what we hid, so we don't fight the page's own logic.
        const ok = await setAssistantHiddenBatch(qsa('[data-pn-grouped-hidden="1"]'), false, opSeq);
        if (!ok || opSeq !== groupedOpSeq) return;
        clearGroupedToggleButtons();
        clearGroupedPromptMarkers();
        groupedActiveUserEl = null;
        showToast('Grouped view: OFF');

        if (anchorEl && typeof anchorTopBefore === 'number') {
          // Let layout settle, then compensate for newly unhidden content above.
          setTimeout(() => {
            try {
              if (!document.contains(anchorEl)) return;
              const anchorTopAfter = anchorEl.getBoundingClientRect().top;
              const delta = anchorTopAfter - anchorTopBefore;
              if (Number.isFinite(delta) && Math.abs(delta) > 1) {
                window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
              }
            } catch {
              // ignore
            }
          }, 0);
        }
      }
    } finally {
      if (busyDelayTimer) {
        clearTimeout(busyDelayTimer);
        busyDelayTimer = null;
      }
      if (opSeq === groupedOpSeq) hideBusy();
    }
  }

  // Apply persisted state on load.
  if (groupedViewEnabled) {
    // Delay slightly so initial transcript hydration doesn't fight us.
    setTimeout(() => setGroupedViewEnabled(true), 350);
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

  ensureCollapseStyles();
  startCollapseObserver();
  scheduleCollapseEnhance();

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

    // In grouped view, navigation also "selects" a group and expands its assistant blocks.
    if (groupedViewEnabled) {
      groupedActiveUserEl = lastSelectedEl;
      applyGroupedViewState({ preferCurrent: true });
    }
  }

  chromeRuntime()?.onMessage?.addListener?.((msg) => {
    if (!msg) return;
    if (msg.type === 'PROMPT_NAVIGATE') {
      if (msg.dir === 'next' || msg.dir === 'prev') navigate(msg.dir);
    } else if (msg.type === 'PROMPT_COLLAPSE_TOGGLE_ALL') {
      toggleCollapseAllHeadings();
    } else if (msg.type === 'PROMPT_OUTLINE_TOGGLE') {
      // Back-compat: older workers used this name for "toggle outline".
      // We now treat it as grouped view toggle.
      setGroupedViewEnabled(!groupedViewEnabled);
    } else if (msg.type === 'PROMPT_GROUPED_VIEW_TOGGLE') {
      setGroupedViewEnabled(!groupedViewEnabled);
    }
  });

  function isEditableEl(el) {
    if (!(el instanceof Element)) return false;
    if (el.isContentEditable) return true;
    // Common chat inputs (including custom editors) often use role="textbox".
    if (el.getAttribute('role') === 'textbox') return true;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true';
  }

  function isTypingContext(e) {
    const t = e?.target;
    if (isEditableEl(t)) return true;
    if (t instanceof Element) {
      if (t.closest('input,textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"]')) return true;
    }
    const a = document.activeElement;
    if (isEditableEl(a)) return true;
    if (a instanceof Element) {
      if (a.closest('input,textarea,[contenteditable=""],[contenteditable="true"],[role="textbox"]')) return true;
    }
    return false;
  }

  // Fallback for cases where the browser doesn't dispatch the extension command
  // (or a shortcut is unassigned). On macOS, Option+P produces "π" in inputs, so
  // we preventDefault when we recognize our shortcuts.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      if (isTypingContext(e)) return;
      if (!e.altKey || e.ctrlKey || e.metaKey) return;

      const k = (e.key || '').toLowerCase();
      if (e.shiftKey && k === 'o') {
        // Fallback for grouped view toggle (mirrors the extension command).
        e.preventDefault();
        e.stopPropagation();
        setGroupedViewEnabled(!groupedViewEnabled);
        return;
      }

      if (e.shiftKey) return;
      if (k !== 'j' && k !== 'k') return;

      e.preventDefault();
      e.stopPropagation();
      navigate(k === 'j' ? 'next' : 'prev');
    },
    true
  );
})();
