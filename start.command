#!/bin/bash
set -euo pipefail
cd -P "$(dirname "$0")"
export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ ! -f ui/dist/index.html ] || [ ! -d .local/market-browser-runtime/node_modules/playwright ]; then
    echo '请先运行 bash setup.command 完成初始化。'
    exit 1
fi
exec python3 server.py "$@"
