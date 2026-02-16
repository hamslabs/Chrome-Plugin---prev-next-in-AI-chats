/* eslint-disable no-console */
/* Real-site smoke test using an already-open manual Chrome/Brave session over CDP.
 *
 * Preconditions:
 * 1) Start browser manually with remote debugging enabled.
 * 2) Be logged into chatgpt.com in that browser.
 * 3) Open a real conversation tab (https://chatgpt.com/c/...).
 * 4) Ensure unpacked extension is enabled in that browser profile.
 *
 * Run:
 *   CDP_URL=http://127.0.0.1:9222 node e2e/chatgpt_real_cdp.js
 */

async function main() {
  const playwright = require('playwright');
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  const requestedUrl = process.env.CHATGPT_TEST_URL || '';

  const browser = await playwright.chromium.connectOverCDP(cdpUrl);
  try {
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error('No browser contexts found over CDP.');
    const context = contexts[0];

    const pages = context.pages();
    if (!pages.length) throw new Error('No pages found in the CDP browser.');

    const pageUrls = pages.map((p) => p.url());
    console.log('CDP pages:', pageUrls);

    let page =
      pages.find((p) => /chatgpt\.com\/c\//.test(p.url())) ||
      pages.find((p) => /chatgpt\.com/.test(p.url())) ||
      pages[0];

    await page.bringToFront();
    if (requestedUrl) {
      await page.goto(requestedUrl, { waitUntil: 'domcontentloaded' });
    } else if (!/chatgpt\.com/.test(page.url())) {
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    }

    const turnSelectors = [
      'article[data-testid="conversation-turn"]',
      'article[data-testid^="conversation-turn"]',
      'article[data-testid*="conversation-turn"]',
      '[data-testid="conversation-turn"]',
      '[data-testid^="conversation-turn"]',
      '[data-testid*="conversation-turn"]'
    ];
    const anyMessageSel = [
      '[data-message-author-role="user"]',
      '[data-message-author-role="assistant"]',
      '[data-author="user"]',
      '[data-author="assistant"]',
      '[data-role="user"]',
      '[data-role="assistant"]'
    ].join(', ');
    await page.waitForTimeout(1200);

    const probe = await page.evaluate(({ turnSelectors, anyMessageSel }) => {
      const turnCounts = {};
      for (const sel of turnSelectors) turnCounts[sel] = document.querySelectorAll(sel).length;
      const turns = Object.values(turnCounts).reduce((m, n) => Math.max(m, n), 0);
      const anyMessages = document.querySelectorAll(anyMessageSel).length;
      const bodyText = (document.body?.innerText || '').slice(0, 4000);
      const testIds = Array.from(document.querySelectorAll('[data-testid]'))
        .map((n) => n.getAttribute('data-testid'))
        .filter(Boolean)
        .slice(0, 40);
      return {
        url: location.href,
        title: document.title,
        turns,
        turnCounts,
        anyMessages,
        sampleTestIds: testIds,
        hasHelpCenterError: /Something went wrong/i.test(bodyText) && /help\.openai\.com/i.test(bodyText),
        hasLoginPrompt:
          /log in|continue with|verify you're human|enter code|check your email/i.test(bodyText)
      };
    }, { turnSelectors, anyMessageSel });

    if (probe.turns === 0 && probe.anyMessages === 0) {
      throw new Error(
        `No chat messages found on current page (${page.url()}). ` +
          `title=${probe.title}, turns=${probe.turns}, anyMessages=${probe.anyMessages}, ` +
          `turnCounts=${JSON.stringify(probe.turnCounts)}, sampleTestIds=${JSON.stringify(probe.sampleTestIds)}, ` +
          `helpCenterError=${probe.hasHelpCenterError}, loginPrompt=${probe.hasLoginPrompt}. ` +
          `Open a real chat URL (https://chatgpt.com/c/...) in the CDP browser and rerun.`
      );
    }

    const preToggle = await page.evaluate(() => ({
      badge: !!document.querySelector('#__promptnav_badge'),
      btns: document.querySelectorAll('button.__pn_group_btn').length,
      hidden: document.querySelectorAll('[data-pn-grouped-hidden="1"]').length
    }));

    // Ensure we're not focused in the composer before shortcut.
    await page.evaluate(() => {
      try {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      } catch {
        // ignore
      }
    });
    await page.keyboard.press('Alt+Shift+O');
    await page.waitForTimeout(450);

    const postToggle = await page.evaluate(() => ({
      badge: !!document.querySelector('#__promptnav_badge'),
      btns: document.querySelectorAll('button.__pn_group_btn').length,
      hidden: document.querySelectorAll('[data-pn-grouped-hidden="1"]').length,
      toast: document.querySelector('#__promptnav_toast')?.textContent || ''
    }));

    if (postToggle.btns === 0 && postToggle.hidden === 0) {
      throw new Error(
        'Grouped-view toggle appears not to have run in the page. ' +
          `pre=${JSON.stringify(preToggle)} post=${JSON.stringify(postToggle)} ` +
          `url=${page.url()}. Ensure unpacked extension is enabled for this profile/tab.`
      );
    }

    const assistantTurnSel =
      'article[data-testid="conversation-turn"]:has([data-message-author-role="assistant"]),' +
      'article[data-testid^="conversation-turn"]:has([data-message-author-role="assistant"]),' +
      'article[data-testid*="conversation-turn"]:has([data-message-author-role="assistant"]),' +
      '[data-testid="conversation-turn"]:has([data-message-author-role="assistant"]),' +
      '[data-testid^="conversation-turn"]:has([data-message-author-role="assistant"]),' +
      '[data-testid*="conversation-turn"]:has([data-message-author-role="assistant"]),' +
      '[data-role="assistant"],[data-author="assistant"]';
    await page.waitForTimeout(300);
    const collapseProbe = await page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      const markedHidden = Array.from(document.querySelectorAll('[data-pn-grouped-hidden="1"]'));
      return {
        matchedAssistants: els.length,
        markedHidden: markedHidden.length,
        markedHiddenVisible: markedHidden.filter((el) => getComputedStyle(el).display !== 'none').length,
        toastText: document.querySelector('#__promptnav_toast')?.textContent || '',
        badgeText: document.querySelector('#__promptnav_badge')?.textContent || ''
      };
    }, assistantTurnSel);
    const collapsed = collapseProbe.markedHidden > 0 && collapseProbe.markedHiddenVisible === 0;
    if (!collapsed) {
      throw new Error(
        'Expected grouped view ON to collapse assistant turns. ' +
          `probe=${JSON.stringify(collapseProbe)}`
      );
    }

    const btnSel =
      'article[data-testid="conversation-turn"]:has([data-message-author-role="user"]) button.__pn_group_btn,' +
      'article[data-testid^="conversation-turn"]:has([data-message-author-role="user"]) button.__pn_group_btn,' +
      'article[data-testid*="conversation-turn"]:has([data-message-author-role="user"]) button.__pn_group_btn,' +
      '[data-testid="conversation-turn"]:has([data-message-author-role="user"]) button.__pn_group_btn,' +
      '[data-testid^="conversation-turn"]:has([data-message-author-role="user"]) button.__pn_group_btn,' +
      '[data-testid*="conversation-turn"]:has([data-message-author-role="user"]) button.__pn_group_btn,' +
      '[data-role="user"] button.__pn_group_btn,[data-author="user"] button.__pn_group_btn';
    await page.waitForSelector(btnSel, { timeout: 10_000 });
    await page.click(btnSel);
    await page.waitForTimeout(300);

    const visibleCount = await page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      return els.filter((el) => getComputedStyle(el).display !== 'none' && el.dataset.pnGroupedHidden !== '1').length;
    }, assistantTurnSel);
    if (visibleCount < 1) throw new Error('Expected at least one assistant turn visible after clicking the prompt toggle button.');

    console.log('CDP REAL SITE SMOKE OK');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
