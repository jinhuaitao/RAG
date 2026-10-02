#!/usr/bin/env bash
# 可选的命令行部署路径（README 附录）。主路径是在 Cloudflare 控制台连 GitHub 部署，不需要本脚本。
# 用法：
#   ADMIN_TOKEN=xxx CLOUDFLARE_API_TOKEN=yyy CLOUDFLARE_ACCOUNT_ID=zzz bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
W=npx

if ! $W wrangler whoami >/dev/null 2>&1 && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "✗ 未登录 Cloudflare：先执行 npx wrangler login，或设置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID" >&2
  exit 1
fi

echo "==> 部署 Worker"
$W wrangler deploy

echo "==> 写入 Secrets（只写入环境变量里提供的项）"
for name in ADMIN_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    printf '%s' "$value" | $W wrangler secret put "$name"
  else
    echo "    跳过 $name（未提供环境变量）"
  fi
done

cat <<'EOF'

✓ 部署完成。剩下两步在浏览器里做：
  1. 打开 Worker 的 workers.dev 地址，右上角填入 ADMIN_TOKEN 并保存
  2. 点页面上的「初始化资源」，Worker 会自动创建 D1 数据库、两张表和 Vectorize 索引
     （等价命令：curl -X POST $BASE/api/admin/setup -H "authorization: Bearer $ADMIN_TOKEN"）
EOF
