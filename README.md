# Cloudflare RAG 知识库问答

一个**在 Cloudflare 网页控制台连上 GitHub 就部署完成**的检索增强问答（RAG）服务：上传或粘贴文档，向量化存进 Vectorize，提问时召回相关片段并让大模型**只依据你的资料**作答，回答里的 `[1]` 可点开核对原文。

全程不需要本地安装 wrangler，不需要 GitHub Actions，也不需要任何第三方 API Key：

- **Workers** 跑逻辑，**Workers Assets** 直出前端单页（零构建步骤）
- **Workers AI** 做嵌入与生成（免费额度即可跑通）
- **D1** 存文档与切片原文，**Vectorize** 存向量
- 首次部署后，Worker **自己调用 Cloudflare REST API 建库、建表、建向量索引**——点一下页面上的「初始化资源」按钮就完成，无需手填任何资源 ID

```
浏览器 ──▶ Worker (src/index.js)
             │  POST /api/admin/setup  建 D1 库 → 建表 → 建 Vectorize 索引（幂等）
             │  POST /api/documents    切片 → 嵌入 → upsert 向量 + 存原文
             │  POST /api/ask          问题嵌入 → 向量检索 → 取原文 → 生成回答
             ├─▶ env.AI                Workers AI 绑定（嵌入 / 生成）
             ├─▶ env.ASSETS            public/ 里的问答页面
             └─▶ Cloudflare REST API   D1 + Vectorize（用两个 Secret 鉴权，见下文）
```

> 为什么走 REST 而不是绑定：Vectorize 索引**在控制台没有创建入口**，只能靠 `wrangler` 或 API；而 Workers 的 Git 集成在首次部署时无法接受占位符资源 ID。把建资源这件事交给 Worker 自己完成，才真正做到「控制台点几下就上线」。代价是 Worker 持有一个能创建/删除资源的 Token，所以访问令牌是**强制**的，详见[安全说明](#安全说明)。

## 目录

- [一键部署（Cloudflare 控制台）](#一键部署cloudflare-控制台)
- [第一次使用](#第一次使用)
- [入库时如何优化资料](#入库时如何优化资料)
- [本地跑起来](#本地跑起来)
- [HTTP API](#http-api)
- [配置项](#配置项)
- [换模型 / 换维度](#换模型--换维度)
- [常见问题](#常见问题)
- [安全说明](#安全说明)
- [项目结构](#项目结构)
- [附录 A：命令行部署](#附录-a命令行部署)
- [附录 B：GitHub Actions 自动部署](#附录-bgithub-actions-自动部署)

## 一键部署（Cloudflare 控制台）

准备：一个 GitHub 仓库、一个 Cloudflare 账号（免费计划即可）。下面四步全在浏览器里完成。

### 第 1 步：把代码推到 GitHub

```bash
cd rag-kb-cloudflare          # 本目录
git init -b main
git add .
git commit -m "feat: Cloudflare RAG 知识库问答"
gh repo create rag-kb-cloudflare --private --source=. --push
```

没有 `gh` 就在 GitHub 网页上新建空仓库，再 `git remote add origin … && git push -u origin main`。

### 第 2 步：控制台连 GitHub 部署 Worker

Cloudflare 控制台 → **Workers & Pages → Create → Workers → Get started → Connect to Git**：

| 设置项 | 填什么 |
| --- | --- |
| 项目名称 / Worker name | `rag-kb`（与 `wrangler.jsonc` 的 `name` 保持一致） |
| 仓库 / 分支 | 第 1 步的仓库，分支 `main` |
| Build command | 留空（零构建） |
| Entry point | 留空，配置里已声明 `src/index.js` |

点 **Deploy**。约 1 分钟后拿到地址：

```
https://rag-kb.<你的账号子域>.workers.dev
```

这一步一定能成功——`wrangler.jsonc` 只声明了 AI 与 Assets 两个绑定，没有需要预先存在的资源 ID。

### 第 3 步：加三个 Secret

先造一个 API Token：控制台右上角头像 → **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** 模板，确认包含下列权限，Account 范围选你的账号：

| 权限 | 用途 |
| --- | --- |
| `Account · Workers Scripts: Edit` | Git 集成部署 Worker |
| `Account · Workers D1: Edit` | 建库、建表、读写文档 |
| `Account · Workers Vector Store: Edit` | 建索引、写入与检索向量 |
| `Account · Workers AI: Read & Edit` | 调用嵌入与生成模型 |

然后到 **Workers & Pages → rag-kb → Settings → Variables and Secrets → Variables**，把下面三项的**类型选 Secret**（不是 Text）后保存：

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上面造的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 控制台右侧栏 **Account ID**（也可在任意页面 URL 里看到） |
| `ADMIN_TOKEN` | 你自己定的随机长字符串，访问页面时要用它登录。生成一个：`openssl rand -hex 24` |

改完如果状态未生效，去 **Deployments → 最新一次 → Retry deployment** 重跑一次即可。

> 若控制台提示这些变量由 Git 集成管理，就改在 **Settings → Build settings → Variables and secrets** 里添加，效果相同。

### 第 4 步：点「初始化资源」

打开 Worker 地址，页面顶部会有「还差一步：初始化资源」横幅。

1. 右上角填入 `ADMIN_TOKEN` → **保存**（只存在浏览器 localStorage）
2. 点 **初始化资源**

Worker 会依次创建 D1 数据库 `rag-kb-db`、`documents` / `chunks` 两张表、Vectorize 索引 `rag-kb-index`（1024 维 / cosine），几秒后横幅消失，顶部状态栏显示「0 篇文档 · 0 个片段 · …」。这个动作**幂等**，重复点只会跳过已存在的资源。

命令行等价：

```bash
curl -s -X POST https://rag-kb.<子域>.workers.dev/api/admin/setup \
  -H 'authorization: Bearer <ADMIN_TOKEN>'
```

## 第一次使用

1. 切到**知识库管理** → 粘贴正文，或选择 `.txt / .md / .csv / .json / .html` 文件（可多选）→ **入库**。入库前会自动做一轮[资料优化](#入库时如何优化资料)，然后切成约 600 字符、带 120 字符重叠的片段，同时写入 D1 与向量索引。提示行会写明「211 → 137 字（去掉 5 行噪声、合并 2 处断行）」。
2. 回到**问答** → 输入问题（⌘/Ctrl + Enter 提交）→ 回答中的 `[1]` 是引用角标，下方来源卡片给出相似度分数与原文摘录，据此可核对模型有没有编造。
3. 资料写错或过时 → 在知识库列表点**删除**，向量与切片一起清掉。
4. 之后每次 `git push` 只更新代码，D1 与 Vectorize 里的数据不会丢。

## 入库时如何优化资料

粘贴网页、Word 或 PDF 转出的文本往往带着一堆排版噪声，直接被切片会污染召回。入库前 `src/lib/clean.js` 会做一轮**纯规则**清洗（不调用模型，因此不会改写任何事实、不消耗 AI 额度）：

- **去掉噪声行**：面包屑导航（`官网 > 帮助中心 > 开票说明`）、`返回顶部`、`分享 收藏 点赞`、版权声明与备案号、`第 3 页` 之类页码、`第一章 总则……… 12` 目录点线、markdown 表格的 `|---|---|` 分隔行。
- **去掉跨页重复的页眉页脚**：同一短行在文档里出现 3 次以上即判定为页眉/水印。
- **合并被硬断开的行**：PDF/Word 常把一句中文断成几行，清洗会按语义接回完整句子（英文跨行断词 `exam-\nple` 也会拼回）。
- **展开行内标记**：`[开票指南](https://…)` 只留「开票指南」，`![图](…)` 只留 alt，`<br>`、`<strong>` 等标签去掉，`&nbsp;` 等实体还原。
- **注入章节路径**：识别 markdown 标题、`第X条/章/节`、`一、`、`（一）`、`2.1` 等序号，把所属章节写进每个片段开头，例如 `【一、发票开具】\n电子发票在订单完成后…`。跨章节之间不做重叠，避免把上一章内容混进本章召回。

删除策略刻意保守：只有**整行**都是噪声词、或短行（≤40 字且不以句号结尾）命中强噪声特征时才删。所以「本文件版权所有，未经授权不得转发。」这种正文会完整保留，而页脚的「版权所有 侵权必究」会被清掉。清洗后的文本就是库里保存的文本。

## 本地跑起来

前置：Node ≥ 22。

```bash
npm install
npm run preview      # → http://127.0.0.1:8790 ，访问令牌 mock-token
```

`preview` 启动的是**离线端到端模拟**：内存版 D1 + 向量库 + 假 Workers AI，并且**自带一个假的 Cloudflare REST API 服务**（端口 8791），所以「初始化资源 → 入库 → 问答 → 删除」整条真实代码路径都能在完全不登录、不花额度的情况下跑通。数据重启即清空。

想调真实资源：

```bash
cp .dev.vars.example .dev.vars    # 填三个 Secret 的值
npx wrangler login
npm run dev                       # wrangler dev --remote
```

注意 `npm run dev` 连的是**你账号里真实的** D1 / Vectorize / Workers AI：入库和初始化会真的建资源、消耗额度。日常调试建议用 `preview`。

其他脚本：

```bash
npm test           # 切片逻辑单元测试（中文分段 / 重叠 / HTML 抽取）
npm run check      # 全部 JS 语法检查
npm run schema:dump# 由 src/lib/schema.js 重新导出 schema.sql
npm run deploy     # 只部署代码，不建资源
```

## HTTP API

```bash
BASE=https://rag-kb.<子域>.workers.dev
AUTH='authorization: Bearer <ADMIN_TOKEN>'

# 状态（唯一免鉴权接口）：是否已初始化、文档/片段数、生效配置
curl -s $BASE/api/status

# 初始化资源（幂等）：建 D1 库 + 两张表 + Vectorize 索引
curl -s -X POST $BASE/api/admin/setup -H "$AUTH"

# 入库（粘贴文本）
curl -s -X POST $BASE/api/documents -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"退货政策","text":"退货申请需在签收后七天内提交……"}'
# → {"ok":true,"docId":"…","title":"退货政策","chunkCount":4,
#    "cleaned":{"before":1204,"after":913,"droppedLines":5,"mergedLines":8},
#    "embedding":{"count":4,"model":"@cf/baai/bge-m3","dimensions":1024,"mutations":["…"]}}

# 入库（上传文件，multipart）
curl -s -X POST $BASE/api/documents -H "$AUTH" -F 'file=@手册.md'

# 列表 / 删除
curl -s $BASE/api/documents -H "$AUTH"
curl -s -X DELETE $BASE/api/documents/<docId> -H "$AUTH"

# 问答
curl -s -X POST $BASE/api/ask -H "$AUTH" -H 'content-type: application/json' \
  -d '{"question":"退货申请要在几天内提交？","topK":4}'
# → {"answer":"…[1]","sources":[{"index":1,"title":"退货政策","score":0.82,"excerpt":"…"}]}
```

除 `/api/status` 外全部要求令牌；出错时返回 `{"error":"中文说明","details":{"hint":"下一步该做什么"}}`，HTTP 码遵循 400/401/404/405/413/415/5xx。

## 配置项

都在 `wrangler.jsonc` 的 `vars` 里（不涉及密钥），改完重新部署生效——控制台路径下就是往仓库提一次 commit。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_NAME` | `rag-kb-db` | D1 数据库名，初始化按这个名字创建/查找 |
| `INDEX_NAME` | `rag-kb-index` | Vectorize 索引名 |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | 嵌入模型，多语言，适合中文资料 |
| `EMBEDDING_DIMENSIONS` | `1024` | **必须与索引维度一致**，初始化时用它建索引 |
| `EMBEDDING_METRIC` | `cosine` | 距离度量 |
| `CHAT_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8` | 生成模型 |
| `TOP_K` | `6` | 默认召回片段数，请求里可用 `topK` 覆盖（1–20） |
| `CHUNK_MAX_CHARS` | `600` | 单切片目标长度（字符） |
| `CHUNK_OVERLAP_CHARS` | `120` | 相邻切片重叠，防止句子在边界被切断 |
| `MAX_DOC_CHARS` | `200000` | 单篇文档上限，超出返回 413 |
| `MAX_CONTEXT_CHARS` | `12000` | 拼进提示词的参考资料总长度上限 |
| `ACCOUNT_ID` | 空 | 备用；优先读 Secret `CLOUDFLARE_ACCOUNT_ID` |

## 换模型 / 换维度

嵌入模型换了维度就变了，向量无法迁移，必须重建索引：

1. 删掉旧索引（Vectorize 没有可靠的控制台入口，用 API 最稳）：

   ```bash
   T=<你的 Token>; A=<Account ID>; I=rag-kb-index
   curl -s -X DELETE -H "authorization: Bearer $T" \
     "https://api.cloudflare.com/client/v4/accounts/$A/vectorize/v2/indexes/$I"
   ```

2. 改 `wrangler.jsonc` 的 `EMBEDDING_MODEL`、`EMBEDDING_DIMENSIONS`，建议同时换 `INDEX_NAME`，提交部署。
3. 页面重新点**初始化资源**建新索引。
4. 旧文档的向量已失效：在知识库列表里逐篇删除后重新入库。

只换生成模型（`CHAT_MODEL`）不影响向量，改完部署即可。

## 常见问题

**页面提示「缺少 Cloudflare API 凭据」/ 状态里 `provision.credentials` 为 false**
第 3 步的两个 Secret 没生效。确认名称拼写正确、类型是 **Secret** 而不是 Text，然后 Retry deployment。

**点初始化报「索引已存在但维度是 N，与配置不符」（409）**
`EMBEDDING_DIMENSIONS` 与账号里同名索引的真实维度不一致。把配置改成实际维度，或删掉那个索引再点。

**入库报「向量维度不匹配」**
`EMBEDDING_MODEL` 的输出维度 ≠ `EMBEDDING_DIMENSIONS`。查该模型的实际维度并改正，然后按[换模型 / 换维度](#换模型--换维度)重建。

**问答报「生成模型 … 已下线 / 调用失败」**
Workers AI 会定期下线旧模型（例如 `@cf/meta/llama-3.1-8b-instruct` 已于 2026-05-30 下线，错误码 5028）。这类问题不用改代码：把 `wrangler.jsonc` 的 `CHAT_MODEL` 换成仍在架的 ID 再提交即可，同架构通常加个量化后缀就能对上（`…-instruct` → `…-instruct-fp8`）。完整清单见 [workers-ai/models](https://developers.cloudflare.com/workers-ai/models/) 里的 Text Generation，或登录后运行 `npx wrangler ai models list`。中文资料想要更好效果，可换 Qwen / Gemma 一类多语言模型试试。

**能上传 PDF / Word 吗？**
不能，接口返回 415 并说明原因：Worker 里没有可靠的二进制解析。请先导出为 `.md` 或 `.txt`（`pandoc in.docx -t gfm -o out.md`）。

**回答不准 / 漏信息**
先把「召回片段数」调到 10；仍不行就把长文档按主题拆成多篇（标题会出现在参考资料里，有助于定位），或调大 `CHUNK_MAX_CHARS`。

**忘了 `ADMIN_TOKEN`**
它只以 Secret 形式存在 Worker 侧，无法查看。在控制台 Settings 里删掉再设一个新值，页面右上角填新值即可，知识库数据不受影响。

**额度**
Workers 免费计划含每天 10 万次请求；Workers AI 的免费用量按模型分配（嵌入与生成各有每日上限）；Vectorize 免费计划可建索引并存放有限向量。个人知识库够用，规模化前请在控制台核对 Workers AI 与 Vectorize 的当前配额说明。

## 安全说明

- **访问令牌强制**：Worker 持有的 API Token 能创建/删除资源，因此除 `/api/status` 外所有接口都要求 `Authorization: Bearer <ADMIN_TOKEN>`，未设置该 Secret 时接口直接返回 403 并给出配置指引。令牌比较走 `crypto.timingSafeEqual`。
- **Token 最小化**：请只授予上表那几项权限，不要把 Global Key 或 Zone 权限塞进来；这个 Token 会随每次请求出现在 Worker 的出站头里。
- **不会被注入**：文档正文、回答与来源一律用 `textContent` 渲染，不执行任何 HTML；SQL 全部走占位符参数。
- **有上限**：请求体、单篇文档长度、召回片段数都有边界，PDF 等二进制直接拒收。
- 建议给 Worker 域名开启访问控制（Zero Trust / Access）或至少保持 `ADMIN_TOKEN` 足够长。

## 项目结构

```
wrangler.jsonc           只声明 AI + Assets 绑定，以及所有可调参数
schema.sql               由 src/lib/schema.js 导出的建表 SQL（仅作参考，运行时不读文件）
src/index.js             路由、鉴权、参数校验，唯一的 HTTP 入口
src/lib/cfapi.js         Cloudflare REST API 封装：D1 建库/查询、Vectorize 建索引/NDJSON 写入/检索/删除
src/lib/setup.js         「初始化资源」的幂等逻辑与 provisioning 状态探测
src/lib/store.js         通过 REST 读写 D1（切片原文按向量 id 回查）
src/lib/rag.js           嵌入、批量 upsert、向量检索、维度校验
src/lib/chunk.js         中英混合文本切片（段落 → 句子 → 重叠打包）与标题层级识别
src/lib/clean.js         入库前的规则清洗：去噪声行、合并硬断行、展开行内标记
src/lib/answer.js        中文系统提示词、上下文拼装、生成调用
src/lib/http.js          JSON 响应、错误包装、请求体解析、令牌校验
public/                  问答与知识库管理页面（原生 HTML/CSS/JS，无构建）
scripts/dev-mock.mjs     离线端到端模拟，含一个假的 Cloudflare REST API
scripts/deploy.sh        附录 A 的命令行部署路径
scripts/test.mjs         切片逻辑测试
scripts/check.sh         语法检查
.github/workflows/       附录 B 的 GitHub Actions 部署路径
```

## 附录 A：命令行部署

习惯本地 wrangler 的话，一条脚本等价于上面第 2–3 步（第 4 步仍在浏览器里点按钮，或用前面的 `curl`）：

```bash
export CLOUDFLARE_API_TOKEN=<Token>
export CLOUDFLARE_ACCOUNT_ID=<Account ID>
export ADMIN_TOKEN=<自定义访问令牌>
npm install
bash scripts/deploy.sh      # 等价 npm run setup
```

脚本做三件事：`wrangler deploy` → 把上述三个环境变量写成 Secret → 打印剩下的浏览器步骤。未提供的变量会被跳过并提示。

## 附录 B：GitHub Actions 自动部署

仓库自带 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)：push 到 `main` 时跑语法检查与离线测试，然后 `wrangler deploy`。它**只部署代码**，不建资源（资源由 Worker 自己在页面里创建），因此只需要两个 Secret：

仓库 → Settings → Secrets and variables → Actions → New repository secret：

```
CLOUDFLARE_ACCOUNT_ID   = 你的 Account ID
CLOUDFLARE_API_TOKEN    = 权限见第 3 步表格
```

与控制台连 Git 二选一即可，同时启用会互相覆盖同一个 Worker。
