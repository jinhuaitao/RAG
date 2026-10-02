# Cloudflare RAG 知识库问答

一个**推到 GitHub 就自动部署到 Cloudflare** 的检索增强问答（RAG）服务：上传或粘贴文档，向量化存进 Vectorize，提问时召回相关片段并让大模型**只依据你的资料**作答，附带可核对的来源引用。

全部运行在 Cloudflare 边缘：Workers（逻辑）+ Workers AI（嵌入与生成）+ Vectorize（向量库）+ D1（文档与切片）+ Workers Assets（前端页面）。**零构建步骤、零外部 API Key、无服务器**，免费额度即可跑通。

```
浏览器 ──▶ Worker (src/index.js)
             │  POST /api/documents  切片 → 嵌入 → Vectorize.upsert + D1 存原文
             │  POST /api/ask        问题嵌入 → Vectorize.query → D1 取正文 → 生成回答
             └─▶ env.AI        Workers AI（@cf/baai/bge-m3 嵌入 / Llama 生成）
                 env.VECTORIZE Vectorize 索引（1024 维 / cosine）
                 env.DB        D1（documents / chunks 两张表）
                 env.ASSETS    public/ 里的问答页面
```

## 目录

- [一键部署（GitHub → Cloudflare）](#一键部署github--cloudflare)
- [本地跑起来](#本地跑起来)
- [第一次使用](#第一次使用)
- [开启访问令牌](#开启访问令牌)
- [HTTP API](#http-api)
- [配置项](#配置项)
- [换模型 / 换维度](#换模型--换维度)
- [常见问题](#常见问题)
- [项目结构](#项目结构)

## 一键部署（GitHub → Cloudflare）

仓库自带 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)：它会在每次 push 到 `main` 时自动**创建 D1 数据库与 Vectorize 索引 → 建表 → 部署 Worker**，资源已存在时自动跳过，可反复运行。

**1. 建仓库并推送**

```bash
cd rag-kb-cloudflare          # 本目录
git init -b main
git add .
git commit -m "feat: Cloudflare RAG 知识库问答"
gh repo create rag-kb-cloudflare --private --source=. --push   # 或手动建仓库后 git push
```

**2. 拿一个 Cloudflare API Token**

Cloudflare 控制台 → **My Profile → API Tokens → Create Token**，选 **Edit Cloudflare Workers** 模板，并确认包含：

| 权限 | 用途 |
| --- | --- |
| `Account · Workers Scripts: Edit` | 部署 Worker |
| `Account · Workers D1: Edit` | 建库、执行 `schema.sql` |
| `Account · Workers Vector Store: Edit` | 建 Vectorize 索引 |
| `Account · Workers AI: Read & Edit` | 调用嵌入与生成模型 |

Account 范围选你的账号。**同时记下右上角的 Account ID。**

**3. 在 GitHub 仓库里配置两个 Secret**

仓库 → Settings → Secrets and variables → Actions → New repository secret：

```
CLOUDFLARE_ACCOUNT_ID   = 你的 Account ID
CLOUDFLARE_API_TOKEN    = 上一步的 Token
```

**4. 触发部署**

仓库 → Actions → **Deploy RAG 知识库到 Cloudflare** → Run workflow。
约 1–2 分钟后，在 `deploy` 日志末尾看到：

```
Deployed rag-kb worker (Xs)
  https://rag-kb.<你的账号子域>.workers.dev
```

打开这个地址就是问答页面。以后 `git push` 即自动重新部署，数据（D1 + Vectorize）不会丢。

> **不想用 GitHub Actions？** 本地一条命令等价：`npx wrangler login && npm run setup`（脚本内容与 workflow 完全相同）。
>
> **想用 Cloudflare 自带的 Git 集成（Workers Builds）？** 可以先用上面任一方式部署一次，让 `wrangler.jsonc` 里的 `database_id` 被真实 UUID 替换并提交回仓库，之后再在控制台 Connect to Git——因为 D1 绑定必须有真实 UUID，占位符状态下 Builds 会部署失败。

## 本地跑起来

前置：Node ≥ 20。

```bash
npm install

# 不登录 Cloudflare，也能跑通全流程（AI/Vectorize 用本地模拟实现）
npm run preview        # → http://127.0.0.1:8790

# 真实调用 Cloudflare（需要 npx wrangler login）
npm run setup          # 建 D1 + Vectorize + 建表 + 部署
npm run dev:remote     # 本地热调试，AI 与 Vectorize 走远端
```

`npm run dev`（纯本地 workerd）**当前不可用**：Workers AI 绑定必须建立远端会话，Vectorize 绑定在本地模式标记为 `not supported`。要离线调试就用 `npm run preview`。

其他脚本：

```bash
npm test               # 切片逻辑单元测试（中文分段/重叠/HTML 抽取）
npm run check          # 全部 JS 语法检查
npm run deploy         # 只部署，不建资源
npm run migrate:remote # 只重跑建表 SQL
```

## 第一次使用

1. 打开部署后的域名，顶部状态栏会显示文档数、片段数与所用模型。
2. 切到**知识库管理** → 粘贴正文或选择 `.txt/.md/.csv/.json/.html` 文件（可多选）→ **入库**。每篇文档会被切成约 600 字符、带 120 字符重叠的片段并写入向量索引。
3. 回到**问答** → 输入问题（⌘/Ctrl + Enter 提交）→ 回答中的 `[1]` 是引用角标，下方来源卡片给出相似度分数与原文摘录，可据此核对模型有没有编造。
4. 资料写错或过时 → 在知识库列表点**删除**，向量与切片会一起清掉。

## 开启访问令牌

服务默认对公网开放（`/api/ask` 会消耗你的 Workers AI 额度）。建议设置令牌：

```bash
npx wrangler secret put ADMIN_TOKEN     # 输入一个随机长字符串
```

生效后，除 `GET /api/status` 外的所有接口都要求 `Authorization: Bearer <token>`；页面右上角填入同一令牌即可（只存在浏览器 localStorage）。取消鉴权：`npx wrangler secret delete ADMIN_TOKEN`。

本地调试时把令牌写在 `.dev.vars`（见 `.dev.vars.example`，已被 gitignore）。

## HTTP API

```bash
BASE=https://rag-kb.<子域>.workers.dev
AUTH='authorization: Bearer <ADMIN_TOKEN>'     # 未设令牌时留空

# 状态：文档/片段数量与生效配置
curl -s $BASE/api/status

# 入库（粘贴文本）
curl -s -X POST $BASE/api/documents -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"退货政策","text":"退货申请需在签收后七天内提交……"}'
# → {"ok":true,"docId":"…","title":"退货政策","chunkCount":4,"embedding":{…}}

# 入库（上传文件，multipart）
curl -s -X POST $BASE/api/documents -H "$AUTH" -F 'file=@手册.md'

# 问答
curl -s -X POST $BASE/api/ask -H "$AUTH" -H 'content-type: application/json' \
  -d '{"question":"退货申请要在几天内提交？","topK":4}'
# → {"answer":"…[1]","sources":[{"index":1,"title":"退货政策","score":0.82,"excerpt":"…"}]}

# 列表 / 删除
curl -s $BASE/api/documents -H "$AUTH"
curl -s -X DELETE $BASE/api/documents/<docId> -H "$AUTH"
```

出错时返回 `{"error":"中文说明","details":{"hint":"下一步该做什么"}}`，HTTP 码遵循 400/401/404/405/413/415/5xx。

## 配置项

都在 `wrangler.jsonc` 的 `vars` 里，改完 `npm run deploy` 生效（不涉及密钥）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | 嵌入模型，多语言，适合中文资料 |
| `EMBEDDING_DIMENSIONS` | `1024` | **必须与 Vectorize 索引维度一致** |
| `CHAT_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | 生成模型 |
| `TOP_K` | `6` | 默认召回片段数，请求里可用 `topK` 覆盖（1–20） |
| `CHUNK_MAX_CHARS` | `600` | 单切片目标长度（字符） |
| `CHUNK_OVERLAP_CHARS` | `120` | 相邻切片重叠，防止句子在边界被切断 |
| `MAX_DOC_CHARS` | `200000` | 单篇文档上限，超出返回 413 |
| `MAX_CONTEXT_CHARS` | `12000` | 拼进提示词的参考资料的总长度上限 |

## 换模型 / 换维度

嵌入模型换了维度就变了，必须重建索引：

```bash
npx wrangler ai models list                       # 查当前可用模型（需登录）
npx wrangler vectorize create rag-kb-index-768d \
  --dimensions=768 --metric=cosine --binding=VECTORIZE --update-config
# 改 wrangler.jsonc 的 EMBEDDING_MODEL / EMBEDDING_DIMENSIONS 与索引名，然后
npm run deploy
# 向量不可迁移：删掉旧文档重新入库
```

只换生成模型（`CHAT_MODEL`）不影响向量，改完部署即可。

## 常见问题

**部署时 `wrangler deploy` 报 database_id 无效**
`wrangler.jsonc` 里还是占位符 `REPLACE_BY_PROVISION_SCRIPT`。跑 `npm run setup`（或 Actions 的 workflow）由脚本回填真实 UUID。

**入库报「向量维度不匹配」**
`EMBEDDING_DIMENSIONS` 与索引维度或模型输出对不上，错误信息里会直接给出重建索引的命令。

**问答报「生成模型 … 调用失败」**
Workers AI 模型名会随版本调整。用 `npx wrangler ai models list` 找一个 Text Generation 模型，替换 `CHAT_MODEL` 后重新部署，无需改代码。

**能上传 PDF / Word 吗？**
不能，接口会返回 415 并说明原因：Worker 里没有可靠的二进制解析。请先导出为 `.md` 或 `.txt`（`pandoc in.docx -t gfm -o out.md`）。

**回答不准 / 漏信息**
先提高「召回片段数」到 10；仍不行就把长文档按主题拆成多篇（标题会出现在参考资料里，有助于定位），或调大 `CHUNK_MAX_CHARS`。

**本地 `npm run dev` 起不来**
预期行为，见[本地跑起来](#本地跑起来)：改用 `npm run preview`（离线模拟）或 `npm run dev:remote`（真实调用）。

**额度**
Workers 免费计划含每天 10 万次请求；Workers AI 的免费用量按模型分配（嵌入与生成各有每日上限），Vectorize 免费计划可建索引并存放有限向量。个人知识库够用，规模化前请在控制台核对 Workers AI 与 Vectorize 的当前配额说明。

## 项目结构

```
wrangler.jsonc          Workers 配置：AI / Vectorize / D1 / Assets 绑定与所有可调参数
schema.sql              D1 建表：documents（文档元数据）+ chunks（切片原文）
src/index.js            路由、鉴权、参数校验，唯一的 HTTP 入口
src/lib/chunk.js        中英混合文本切片（段落 → 句子 → 重叠打包）
src/lib/rag.js          嵌入、批量 upsert、向量检索、维度校验
src/lib/store.js        D1 读写（切片原文按向量 id 回查）
src/lib/answer.js       系统提示词与上下文拼装、生成调用
src/lib/http.js         JSON 响应、错误包装、请求体解析、令牌校验
public/                 问答与知识库管理页面（原生 HTML/CSS/JS，无构建）
scripts/provision.sh    幂等建资源 + 回填 config + 迁移 + 部署（CI 与本地共用）
scripts/dev-mock.mjs    离线模拟 D1/Vectorize/AI，用于不登录也能端到端调试
scripts/test.mjs        切片逻辑测试
.github/workflows/deploy.yml  GitHub 一键/持续部署
```

安全上做了这些处理：文档正文与回答一律用 `textContent` 渲染（不会执行 HTML），令牌比较走 `crypto.timingSafeEqual`，请求体与文档长度都有上限，PDF 等二进制直接拒收。
