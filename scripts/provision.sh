#!/usr/bin/env bash
# 幂等地创建 D1 数据库与 Vectorize 索引、回填 wrangler.jsonc、执行迁移并部署。
# 本地：bash scripts/provision.sh            CI：见 .github/workflows/deploy.yml
set -euo pipefail

cd "$(dirname "$0")/.."

DB_NAME="${DB_NAME:-rag-kb-db}"
INDEX_NAME="${INDEX_NAME:-rag-kb-index}"
DIMENSIONS="${EMBEDDING_DIMENSIONS:-1024}"
METRIC="${EMBEDDING_METRIC:-cosine}"
W=npx

if ! $W wrangler whoami >/dev/null 2>&1; then
  echo "✗ 未登录 Cloudflare。本地请先执行：npx wrangler login" >&2
  echo "  CI 环境请设置 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID。" >&2
  exit 1
fi

echo "==> 1/4 D1 数据库 $DB_NAME"
if $W wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
  echo "    已存在，跳过创建"
else
  $W wrangler d1 create "$DB_NAME" --binding=DB --update-config
fi
# 兜底：--update-config 未能写入 UUID 时（例如占位符仍在），从远端读回真实 UUID
if grep -q "REPLACE_BY_PROVISION_SCRIPT" wrangler.jsonc; then
  node scripts/set-config.mjs "$DB_NAME"
fi

echo "==> 2/4 Vectorize 索引 $INDEX_NAME（${DIMENSIONS} 维 / ${METRIC}）"
if $W wrangler vectorize list --json | grep -q "\"$INDEX_NAME\""; then
  echo "    已存在，跳过创建"
else
  $W wrangler vectorize create "$INDEX_NAME" \
    --dimensions="$DIMENSIONS" --metric="$METRIC" \
    --binding=VECTORIZE --update-config
fi

echo "==> 3/4 初始化表结构"
$W wrangler d1 execute "$DB_NAME" --remote --file=schema.sql --yes
$W wrangler d1 execute "$DB_NAME" --local --file=schema.sql --yes

echo "==> 4/4 部署 Worker"
$W wrangler deploy

echo
echo "✓ 完成。下一步："
echo "  · 线上地址见上方 deployments 输出（https://rag-kb.<你的子域名>.workers.dev）"
echo "  · 若需鉴权：npx wrangler secret put ADMIN_TOKEN"
echo "  · 本地开发：npm run dev"
