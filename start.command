#!/bin/bash
set -euo pipefail
cd -P "$(dirname "$0")"
export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ ! -f ui/dist/index.html ]; then
    echo '请先运行 bash setup.command 完成初始化。'
    exit 1
fi
export AI_HUB_ROOT="$PWD"
exec python3 scripts/preview_hub.py --open "$@"
