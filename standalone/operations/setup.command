#!/bin/bash
set -euo pipefail
cd -P "$(dirname "$0")"
export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v python3 >/dev/null || { echo '需要 Python 3.9+。可通过 Homebrew 安装 Python。'; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3,9), "需要 Python 3.9+"'
command -v node >/dev/null || { echo '需要 Node.js 22.12+。可通过 Homebrew 安装 Node.js。'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<12))throw Error("需要 Node.js 22.12+")'
npm --prefix ui ci
npm --prefix ui run build
umask 077
mkdir -p .local/market-browser-runtime
if [ ! -f .local/market-browser-runtime/package.json ]; then
    printf '%s\n' '{"name":"isho-operations-browser","private":true}' > .local/market-browser-runtime/package.json
fi
npm --prefix .local/market-browser-runtime install --save-exact --no-audit --no-fund playwright@1.64.1
node .local/market-browser-runtime/node_modules/playwright/cli.js install chromium
printf '\n初始化完成。运行 bash start.command，或双击 start.command 启动。\n'
