#!/usr/bin/env bash
# 语法校验：Worker 与前端 JS 全部按 ESM 解析检查一遍
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for file in $(find src public scripts -type f \( -name '*.js' -o -name '*.mjs' \) | sort); do
  if node --check "$file" 2>/tmp/check.err; then
    echo "✓ $file"
  else
    echo "✗ $file"
    cat /tmp/check.err
    status=1
  fi
done
exit $status
