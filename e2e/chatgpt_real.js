/* eslint-disable no-console */
/* Real-site smoke test for chatgpt.com with the unpacked extension loaded.
 *
 * Requires:
 *   1) node e2e/chatgpt_login.js  -> creates e2e/storageState.chatgpt.json
 *   2) Browsers installed: npx playwright install chromium
 *
 * Run:
 *   CHATGPT_TEST_URL="https://chatgpt.com/c/..." node e2e/chatgpt_real.js
 * or:
 *   node e2e/chatgpt_real.js
 *
 * Notes:
 * - Extensions require a *persistent* context. Playwright can't directly import
 *   storageState into a persistent context, so we apply cookies/localStorage by hand.
 */

const path = require('path');
const fs = require('fs');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function applyStorageStateToPersistentContext(context, storageState) {
  if (storageState?.cookies?.length) {
    await context.addCookies(storageState.cookies);
  }

  const origins = Array.isArray(storageState?.origins) ? storageState.origins : [];
  for (const o of origins) {
    const origin = o?.origin;
    const local = Array.isArray(o?.localStorage) ? o.localStorage : [];
    if (!origin || local.length === 0) continue;

    const page = await context.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate((items) => {
      for (const it of items) {
        if (!it || typeof it.name !== 'string') continue;
        try {
          localStorage.setItem(it.name, String(it.value ?? ''));
        } catch {
          // ignore
        }
      }
    }, local);
    await page.close();
  }
}

async function main() {
  const playwright = require('playwright');
  const repoRoot = path.resolve(__dirname, '..');
  const extDir = repoRoot;

  const storagePath = path.join(__dirname, 'storageState.chatgpt.json');
  if (!fs.existsSync(storagePath)) {
    die(`Missing ${storagePath}. Run: node e2e/chatgpt_login.js`);
  }

  const userDataDir = path.join(__dirname, '.pw-profile-chatgpt');
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-default-browser-check'
    ]
  });

  try {
    const state = readJson(storagePath);
    await applyStorageStateToPersistentContext(context, state);

    const page = await context.newPage();
    page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));

    const url = process.env.CHATGPT_TEST_URL || 'https://chatgpt.com/';
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for at least one conversation turn to exist.
    const turnSel = 'article[data-testid="conversation-turn"]';
    await page.waitForSelector(turnSel, { timeout: 30_000 });

    // Toggle grouped view (extension command or fallback handler should pick this up).
    await page.keyboard.press('Alt+Shift+O');
    await page.waitForSelector('#__promptnav_toast', { timeout: 10_000 });

    // Verify all assistant turns collapsed.
    const assistantTurnSel = 'article[data-testid="conversation-turn"]:has([data-message-author-role="assistant"])';
    await page.waitForTimeout(350);
    const collapsed = await page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length === 0) return false;
      return els.every((el) => getComputedStyle(el).display === 'none' || el.dataset.pnGroupedHidden === '1');
    }, assistantTurnSel);
    if (!collapsed) die('Expected grouped view ON to collapse assistant turns.');

    // Click the first prompt toggle button and confirm exactly one assistant turn becomes visible.
    const btnSel = `${turnSel}:has([data-message-author-role="user"]) button.__pn_group_btn`;
    await page.waitForSelector(btnSel, { timeout: 10_000 });
    await page.click(btnSel);
    await page.waitForTimeout(350);

    const visibleCount = await page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      return els.filter((el) => getComputedStyle(el).display !== 'none' && el.dataset.pnGroupedHidden !== '1').length;
    }, assistantTurnSel);
    if (visibleCount < 1) die('Expected at least one assistant turn to expand after clicking the toggle button.');

    console.log('REAL SITE SMOKE OK');
    await page.close();
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

