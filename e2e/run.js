/* eslint-disable no-console */
/* Minimal Playwright harness to sanity-check grouped view behavior on a fixture DOM.
 *
 * Note: The sandbox here does not allow binding a localhost server, so we load the
 * fixture via `page.setContent()` and inject `src/content.js` directly with a tiny
 * `chrome.runtime` stub.
 *
 * Prereqs:
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * Run:
 *   node e2e/run.js
 */

const path = require('path');
const fs = require('fs');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeText(p, s) {
  fs.writeFileSync(p, s, 'utf8');
}

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    die('Playwright is not installed. Run: npm i -D playwright');
  }

  const repoRoot = path.resolve(__dirname, '..');
  const fixturePath = path.join(__dirname, 'fixtures', 'chatgpt_like.html');
  if (!fs.existsSync(fixturePath)) die(`Missing fixture: ${fixturePath}`);

  const html = readText(fixturePath);
  const contentJs = readText(path.join(repoRoot, 'src', 'content.js'));
  const manifest = JSON.parse(readText(path.join(repoRoot, 'manifest.json')));
  const versionName = manifest.version_name || manifest.version || 'unknown';

  const headless = process.env.HEADLESS === '1';
  const browser = await playwright.chromium.launch({ headless });
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e));
    page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // `page.setContent()` doesn't reliably trigger `addInitScript()` in all environments,
    // so set the test hooks directly before injecting the content script.
    await page.evaluate(({ versionName }) => {
      globalThis.__promptnav_test_host = 'chatgpt.com';
      globalThis.__promptnav_test_chrome_runtime = {
        getManifest: () => ({ version_name: versionName }),
        onMessage: { addListener: () => {} }
      };
    }, { versionName });

    // Inject content script (runs immediately).
    await page.addScriptTag({ content: contentJs });

    await page.waitForSelector('#__promptnav_badge', { timeout: 10_000, state: 'attached' });

    // Toggle grouped view via the fallback shortcut (Alt+Shift+O).
    await page.keyboard.press('Alt+Shift+O');
    await page.waitForSelector('#__promptnav_toast', { timeout: 5_000 });

    const collapsed = await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('article[data-testid="conversation-turn"]'));
      const assistants = turns.filter((t) => t.querySelector('[data-message-author-role="assistant"]'));
      return assistants.every((a) => a.dataset.pnGroupedHidden === '1' || getComputedStyle(a).display === 'none');
    });
    if (!collapsed) {
      const dbg = await page.evaluate(() => {
        const turns = Array.from(document.querySelectorAll('article[data-testid="conversation-turn"]'));
        const assistants = turns.filter((t) => t.querySelector('[data-message-author-role="assistant"]'));
        return assistants.map((a) => ({
          hiddenFlag: a.dataset.pnGroupedHidden || null,
          inlineStyle: a.getAttribute('style') || null,
          computedDisplay: getComputedStyle(a).display
        }));
      });
      console.error('Collapse debug:', dbg);
      die('Expected grouped view ON to collapse all assistant turns.');
    }

    // Expand first prompt using injected button.
    await page.waitForSelector('article[data-testid="conversation-turn"] button.__pn_group_btn', { timeout: 10_000 });
    const btns = await page.$$('article[data-testid="conversation-turn"] button.__pn_group_btn');
    if (btns.length === 0) die('Expected at least one grouped toggle button.');
    await btns[0].click();

    const expandedOne = await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('article[data-testid="conversation-turn"]'));
      const assistants = turns.filter((t) => t.querySelector('[data-message-author-role="assistant"]'));
      const visible = assistants.filter((a) => getComputedStyle(a).display !== 'none');
      return visible.length === 1;
    });
    if (!expandedOne) {
      const dbg = await page.evaluate(() => {
        const turns = Array.from(document.querySelectorAll('article[data-testid="conversation-turn"]'));
        const assistants = turns
          .filter((t) => t.querySelector('[data-message-author-role="assistant"]'))
          .map((a, i) => ({
            i,
            hiddenFlag: a.dataset.pnGroupedHidden || null,
            inlineStyle: a.getAttribute('style') || null,
            computedDisplay: getComputedStyle(a).display
          }));
        const users = turns
          .filter((t) => t.querySelector('[data-message-author-role="user"]'))
          .map((u, i) => ({
            i,
            hasBtn: !!u.querySelector('button.__pn_group_btn'),
            userText: (u.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)
          }));
        return { users, assistants };
      });
      console.error('Expand debug:', dbg);
      die('Expected clicking first button to expand exactly one assistant turn.');
    }

    console.log('E2E OK');
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
