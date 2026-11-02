#!/usr/bin/env bash
# 从脚本自身定位 Hub；不依赖当前目录或固定用户名。
set -euo pipefail
hub_root=$(cd "$(dirname "$0")/.." && pwd -P)
exec python3 "$hub_root/scripts/hub.py" pull "$@"
