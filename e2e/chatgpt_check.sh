#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./e2e/chatgpt_check.sh <conversation-id-or-url> [cdp-url]
#
# Examples:
#   ./e2e/chatgpt_check.sh 698a2544-9b98-8333-a947-e93a28a58f79
#   ./e2e/chatgpt_check.sh https://chatgpt.com/c/698a2544-9b98-8333-a947-e93a28a58f79
#   ./e2e/chatgpt_check.sh 698a2544-9b98-8333-a947-e93a28a58f79 http://127.0.0.1:9222

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <conversation-id-or-url> [cdp-url]" >&2
  exit 1
fi

conv="${1}"
cdp="${2:-http://127.0.0.1:9222}"

if [[ "${conv}" =~ ^https?:// ]]; then
  chat_url="${conv}"
else
  chat_url="https://chatgpt.com/c/${conv}"
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_dir}"

echo "Running ChatGPT CDP check"
echo "  URL: ${chat_url}"
echo "  CDP: ${cdp}"

CDP_URL="${cdp}" CHATGPT_TEST_URL="${chat_url}" npm run test:chatgpt:check

