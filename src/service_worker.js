async function sendToActiveTab(msg) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // Content script may not be injected on this page.
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-outline') {
    sendToActiveTab({ type: 'PROMPT_OUTLINE_TOGGLE' });
  } else if (command === 'next-prompt') {
    sendToActiveTab({ type: 'PROMPT_NAVIGATE', dir: 'next' });
  } else if (command === 'prev-prompt') {
    sendToActiveTab({ type: 'PROMPT_NAVIGATE', dir: 'prev' });
  }
});

chrome.action.onClicked.addListener(() => {
  sendToActiveTab({ type: 'PROMPT_OUTLINE_TOGGLE' });
});
