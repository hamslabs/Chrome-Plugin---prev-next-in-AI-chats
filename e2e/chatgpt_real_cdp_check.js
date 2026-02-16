/* eslint-disable no-console */
/* One-command CDP check:
 * 1) Connect to manual Chrome/Brave via CDP.
 * 2) Open/attach to ChatGPT conversation page.
 * 3) Toggle grouped view and verify collapse markers/buttons appear.
 * 4) Click first prompt toggle and verify at least one assistant response is visible.
 * 5) Toggle grouped view OFF and verify all responses are restored.
 *
 * Run:
 *   CHATGPT_TEST_URL="https://chatgpt.com/c/..." npm run test:chatgpt:check
 */

const fs = require('fs');
const path = require('path');

function fail(msg, extra) {
  if (extra) console.error(extra);
  throw new Error(msg);
}

async function readGroupedState(page) {
  return page.evaluate(() => {
    const toast = document.querySelector('#__promptnav_toast')?.textContent || '';
    const btns = document.querySelectorAll('button.__pn_group_btn').length;
    const hidden = document.querySelectorAll('[data-pn-grouped-hidden="1"]').length;
    const isOnFromToast = /grouped view:\s*on/i.test(toast);
    const isOffFromToast = /grouped view:\s*off/i.test(toast);
    return { toast, btns, hidden, isOnFromToast, isOffFromToast };
  });
}

async function forceGroupedViewOn(page) {
  // Toggle once, inspect, and if we landed OFF toggle again.
  await page.keyboard.press('Alt+Shift+O');
  await page.waitForTimeout(450);
  let s = await readGroupedState(page);
  if (s.isOffFromToast) {
    await page.keyboard.press('Alt+Shift+O');
    await page.waitForTimeout(450);
    s = await readGroupedState(page);
  }
  return s;
}

async function main() {
  const playwright = require('playwright');
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  const requestedUrl = process.env.CHATGPT_TEST_URL || '';

  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'manifest.json'), 'utf8')
  );
  const expectedVersion = manifest.version_name || manifest.version || 'unknown';

  const browser = await playwright.chromium.connectOverCDP(cdpUrl);
  try {
    const contexts = browser.contexts();
    if (!contexts.length) fail(`No browser contexts found over CDP at ${cdpUrl}.`);
    const context = contexts[0];
    const pages = context.pages();
    if (!pages.length) fail('No pages found in the CDP browser.');

    const page =
      pages.find((p) => /chatgpt\.com\/c\//.test(p.url())) ||
      pages.find((p) => /chatgpt\.com/.test(p.url())) ||
      pages[0];

    await page.bringToFront();
    if (requestedUrl) await page.goto(requestedUrl, { waitUntil: 'domcontentloaded' });
    else if (!/chatgpt\.com/.test(page.url())) await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

    // Ensure shortcut can fire.
    await page.evaluate(() => {
      try {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      } catch {
        // ignore
      }
    });

    const afterToggle = await forceGroupedViewOn(page);
    if (afterToggle.btns === 0 || afterToggle.hidden === 0) {
      fail('Grouped-view toggle check failed.', afterToggle);
    }

    const beforeExpand = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-pn-grouped-hidden="1"]'));
      return {
        hidden: els.filter((el) => getComputedStyle(el).display === 'none').length
      };
    });

    // Try a few prompt buttons until one expands a response.
    const btnCount = await page.locator('button.__pn_group_btn').count();
    const maxTry = Math.min(btnCount, 8);
    let expanded = null;
    for (let i = 0; i < maxTry; i++) {
      await page.locator('button.__pn_group_btn').nth(i).click();
      await page.waitForTimeout(350);
      expanded = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-pn-grouped-hidden="1"]'));
        const stillHidden = els.filter((el) => getComputedStyle(el).display === 'none').length;
        const btns = Array.from(document.querySelectorAll('button.__pn_group_btn')).slice(0, 8);
        return {
          markedHidden: els.length,
          stillHidden,
          toast: document.querySelector('#__promptnav_toast')?.textContent || '',
          btnPreview: btns.map((b) => ({
            text: b.textContent || '',
            cls: b.className || ''
          }))
        };
      });
      if (expanded.stillHidden < beforeExpand.hidden) break;
    }

    if (!expanded || expanded.stillHidden >= beforeExpand.hidden) {
      fail('Expand check failed (no hidden assistant was restored).', expanded || beforeExpand);
    }

    // Collapse the currently-open prompt and ensure it stays collapsed.
    const openBtn = page.locator('button.__pn_group_btn.__pn_open').first();
    await openBtn.click();
    await page.waitForTimeout(450);
    const recollapse = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-pn-grouped-hidden="1"]'));
      const stillHidden = els.filter((el) => getComputedStyle(el).display === 'none').length;
      return {
        markedHidden: els.length,
        stillHidden,
        toast: document.querySelector('#__promptnav_toast')?.textContent || ''
      };
    });
    if (recollapse.stillHidden < beforeExpand.hidden) {
      fail('Recollapse check failed (prompt re-expanded immediately).', recollapse);
    }

    // Toggle grouped view OFF and verify all extension-hidden markers are cleared.
    await page.keyboard.press('Alt+Shift+O');
    await page.waitForTimeout(450);
    const afterOff = await page.evaluate(() => ({
      hidden: document.querySelectorAll('[data-pn-grouped-hidden="1"]').length,
      toast: document.querySelector('#__promptnav_toast')?.textContent || ''
    }));
    if (afterOff.hidden !== 0) {
      fail('Grouped-view OFF check failed (some assistant blocks stayed hidden).', afterOff);
    }

    console.log('CHECK OK');
    console.log(
      JSON.stringify(
        {
          url: page.url(),
          version: expectedVersion,
          groupedView: afterToggle,
          expand: expanded,
          recollapse,
          off: afterOff
        },
        null,
        2
      )
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
