## Prompt Navigator (Chrome/Brave extension)

### What it does
Adds keyboard shortcuts to jump to the next/previous **user prompt** in supported AI chat UIs.

When you trigger a shortcut, the extension:
- Finds the nearest user message blocks in the chat transcript
- Smooth-scrolls to the next/previous one
- Briefly highlights it so you can see what it landed on

### Install (developer mode)
1. Open `chrome://extensions` (or `brave://extensions` in Brave).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

### Default shortcuts
- Next prompt: macOS `Option+J` (others: `Alt+Shift+J`)
- Previous prompt: macOS `Option+K` (others: `Alt+Shift+K`)
- Toggle outline panel: `Alt+Shift+O` (change in `brave://extensions/shortcuts`)

You can change these at `chrome://extensions/shortcuts` (or `brave://extensions/shortcuts`).
Note: if a shortcut conflicts with a browser/system shortcut, the browser may refuse to assign it.

### Supported sites
- ChatGPT (`chatgpt.com`, `chat.openai.com`)
- Claude (`claude.ai`)

### Troubleshooting
- If the keys feel swapped: check `brave://extensions/shortcuts` and make sure the commands are assigned to the keys you expect.
- If nothing happens: reload the extension and refresh the chat tab.
- For the outline panel: click the extension toolbar icon, or use the toggle shortcut. It shows up at the top of the chat transcript (falls back to a floating panel if the transcript container can't be detected).

### Uninstall
Open `brave://extensions` (or `chrome://extensions`) and click **Remove** (or toggle it off to disable).
