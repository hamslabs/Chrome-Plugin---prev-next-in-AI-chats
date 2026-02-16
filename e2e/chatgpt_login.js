/* eslint-disable no-console */
/* Interactive: log into chatgpt.com and save Playwright storageState.
 *
 * Run:
 *   node e2e/chatgpt_login.js
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
  const outPath = path.join(__dirname, 'storageState.chatgpt.json');

  const browser = await playwright.chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Opening chatgpt.com. Log in, then come back here and press Enter.');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

  await promptEnter('Press Enter to save storageState and close the browser... ');

  const state = await context.storageState();
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2), 'utf8');
  console.log(`Saved: ${outPath}`);

  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

