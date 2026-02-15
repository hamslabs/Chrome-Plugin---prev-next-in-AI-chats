## Prompt Navigator (Chrome/Brave extension)

### What it does
Adds keyboard shortcuts to jump to the next/previous **user prompt** in supported AI chat UIs.

When you trigger a shortcut, the extension:
- Finds the nearest user message blocks in the chat transcript
- Smooth-scrolls to the next/previous one
- Briefly highlights it so you can see what it landed on

It also adds optional per-heading collapse toggles to assistant responses (click the small triangle next to headings like "My Recommendation for You Specifically").

### Install (developer mode)
1. Open `chrome://extensions` (or `brave://extensions` in Brave).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

### Default shortcuts
- Next prompt: macOS `Option+J` (others: `Alt+Shift+J`)
- Previous prompt: macOS `Option+K` (others: `Alt+Shift+K`)

You can change these at `chrome://extensions/shortcuts` (or `brave://extensions/shortcuts`).
Note: if a shortcut conflicts with a browser/system shortcut, the browser may refuse to assign it.

### Supported sites
- ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Claude (`claude.ai`)

### Troubleshooting
- If the keys feel swapped: check `brave://extensions/shortcuts` and make sure the commands are assigned to the keys you expect.
- If nothing happens: reload the extension and refresh the chat tab.

### Uninstall
Open `brave://extensions` (or `chrome://extensions`) and click **Remove** (or toggle it off to disable).
