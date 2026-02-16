/* eslint-disable no-console */
/* Capture ChatGPT storageState from a manually launched browser via CDP.
 *
 * 1) Launch Chrome/Brave manually with remote debugging:
 *    Google Chrome:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 \
 *        --user-data-dir="$HOME/.pw-chatgpt-manual"
 *
 *    Brave:
 *      /Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser \
 *        --remote-debugging-port=9222 \
 *        --user-data-dir="$HOME/.pw-chatgpt-manual"
 *
 * 2) In that browser, log into https://chatgpt.com/ fully.
 * 3) Run:
 *      node e2e/chatgpt_capture_state.js
 *
 * Output:
 *   e2e/storageState.chatgpt.json
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

async function promptEnter(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(msg, () => resolve()));
  rl.close();
}

async function main() {
  const playwright = require('playwright');
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  const outPath = path.join(__dirname, 'storageState.chatgpt.json');

  console.log(`Connecting to CDP: ${cdpUrl}`);
  const browser = await playwright.chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('No browser context found over CDP. Open at least one tab in the target browser.');
  }

  console.log('Ensure chatgpt.com is logged in in that browser, then press Enter.');
  await promptEnter('Press Enter to capture storageState... ');

  const state = await context.storageState();
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2), 'utf8');
  console.log(`Saved: ${outPath}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

