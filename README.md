# Cloudflare RAG 知识库问答

在 **Cloudflare 网页控制台**连上 GitHub 就部署完成的检索增强问答服务：上传或粘贴文档 → 向量化存进 Vectorize → 提问时召回相关片段，让大模型**只依据你的资料**作答，回答里的 `[1]` 点开就是原文。

- **不用装 wrangler、不用配 GitHub Actions**，浏览器里点完四步就上线
- **零构建**：Workers 跑逻辑，Workers Assets 直出前端单页
- **自己建资源**：部署后点一下「初始化资源」，Worker 调 Cloudflare REST API 建 D1 库、建表、建向量索引，不用手填任何资源 ID
- **模型走第三方**：OpenAI / DeepSeek / 硅基流动 / 通义千问 compatible-mode / OneAPI-NewAPI 聚合站 / Ollama 都能直接用；第三方平台上没有向量模型时，嵌入自动改走 Cloudflare 自带的 Workers AI

```
浏览器 ──▶ Worker (src/index.js)
             ├─▶ API_URL + API_KEY    第三方接口（embeddings / chat）
             ├─▶ env.AI               Workers AI 向量模型（绑定随部署自动带上）
             ├─▶ env.ASSETS           前端单页（public/）
             └─▶ Cloudflare REST API  D1 + Vectorize
```

> 走 REST 而不是绑定，是因为 Vectorize 索引**在控制台没有创建入口**，只能靠 wrangler 或 API；而 Git 集成首次部署时无法接受占位符资源 ID。把建资源交给 Worker 自己，才真正做到「控制台点几下就上线」。代价是 Worker 持有一个能创建/删除资源的 Token，所以访问令牌是**强制**的，见[安全说明](#安全说明)。

## 目录

- [四步部署](#四步部署cloudflare-控制台)
- [第一次使用](#第一次使用)
- [嵌入走哪儿](#嵌入走哪儿)
- [配置项](#配置项)
- [换模型 / 换维度](#换模型--换维度)
- [工作原理](#工作原理)
- [用网址入库](#用网址入库)
- [常见问题](#常见问题)
- [本地开发](#本地开发)
- [HTTP API](#http-api)
- [安全说明](#安全说明)
- [项目结构](#项目结构)
- [附录：命令行部署](#附录命令行部署)
- [附录：GitHub Actions 自动部署](#附录github-actions-自动部署)

## 四步部署（Cloudflare 控制台）

准备：一个 GitHub 仓库、一个 Cloudflare 账号（免费计划即可）。四步全在浏览器里完成。

### 1 · 把代码推到 GitHub

```bash
cd rag-kb-cloudflare
git init -b main
git add . && git commit -m "feat: Cloudflare RAG 知识库问答"
gh repo create rag-kb-cloudflare --private --source=. --push
```

没有 `gh` 就在 GitHub 网页新建空仓库，再 `git remote add origin … && git push -u origin main`。

### 2 · 控制台连 GitHub 部署 Worker

Cloudflare 控制台 → **Workers & Pages → Create → Workers → Get started → Connect to Git**：

| 设置项 | 填什么 |
| --- | --- |
| Worker name | `rag-kb`（与 `wrangler.jsonc` 的 `name` 一致） |
| 仓库 / 分支 | 上一步的仓库，分支 `main` |
| Build command | 留空（零构建） |
| Entry point | 留空，配置里已声明 `src/index.js` |

点 **Deploy**，约 1 分钟后拿到 `https://rag-kb.<你的账号子域>.workers.dev`。

### 3 · 配 Secret 与模型接口

先造 Token：控制台头像 → **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** 模板，Account 范围选你的账号，确认包含：

| 权限 | 用途 |
| --- | --- |
| `Account · Workers Scripts: Edit` | Git 集成部署 Worker |
| `Account · Workers D1: Edit` | 建库、建表、读写文档 |
| `Account · Workers Vector Store: Edit` | 建索引、写入与检索向量 |

再到 **Workers & Pages → rag-kb → Settings → Variables and Secrets** 添加：

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | **Secret** | 上面造的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | **Secret** | 控制台右侧栏 **Account ID** |
| `ADMIN_TOKEN` | **Secret** | 自定的随机长串，访问页面要用它登录：`openssl rand -hex 24` |
| `API_URL` | Text | 第三方接口根地址，填到 `/v1` 这一层，例如 `https://api.deepseek.com/v1` |
| `API_KEY` | **Secret** | 第三方平台的密钥 |

三条容易踩的：

- `API_URL` 只填根地址，别带 `/chat/completions`（粘了也会被自动截掉）；
- 模型 ID 用平台上登记的**完整名字**——聚合站常给同一个模型挂不同渠道，名字里带后缀（`DeepSeek-V4-Flash(AMD)`、`DeepSeek-V4-Pro(书生·端砚)`），少了后缀就会得到「没有可用渠道支持模型 X」。拿不准就 `curl <API_URL>/models -H 'authorization: Bearer <API_KEY>'` 看一眼，页面报错时也会自动列出来；
- 平台得有**向量模型**才能入库，只提供对话模型的平台只能用来回答问题，见[嵌入走哪儿](#嵌入走哪儿)。

改完去 **Deployments → 最新一次 → Retry deployment** 生效。

> 控制台提示这些变量由 Git 集成管理时，改在 **Settings → Build settings → Variables and secrets** 里添加，效果相同。

### 4 · 点「初始化资源」

打开 Worker 地址，点右上角齿轮，填 `ADMIN_TOKEN` → **保存**（只存在浏览器 localStorage），再点 **初始化资源**。

Worker 会建好 D1 库 `rag-kb-db`、`documents` / `chunks` 两张表、Vectorize 索引 `rag-kb-index`（维度按嵌入模型算：已知模型自动得出，未知模型才看 `EMBEDDING_DIMENSIONS`，默认 1536 维 / cosine）。这个动作**幂等**，重复点只会跳过已存在的资源。

账号里已有维度不对的同名索引时，页面会显示「还差一步：重建向量索引」，点它即可——Worker 删掉旧索引按新维度重建，并把库里保存的正文重新嵌入，**文档不用重传**。

## 第一次使用

1. **知识库管理** → 粘贴正文、选文件（`.txt / .md / .csv / .json / .html`）、或填一个[网页地址](#用网址入库)让 Worker 代抓 → **入库**。入库前会自动[清洗](#入库时如何优化资料)，切成约 600 字符、带 120 字符重叠的片段，同时写入 D1 与向量索引。
2. **问答** → 输入问题（⌘/Ctrl + Enter 提交）。回答里的 `[1]` 是引用角标，下方来源卡给出相似度分数与原文摘录，用来核对模型有没有编造。
3. 资料写错或过时 → 知识库列表点**删除**，向量与切片一起清掉。
4. 之后每次 `git push` 只更新代码，D1 与 Vectorize 里的数据不会丢。

## 嵌入走哪儿

嵌入（把文字变成向量）和生成（回答问题）可以走同一个平台，也可以分开。三种选法：

| 场景 | 怎么配 |
| --- | --- |
| 平台既有对话模型也有向量模型 | 不用配，嵌入与生成都走 `API_URL` / `API_KEY` |
| 平台只有对话模型（DeepSeek 这类本身没有嵌入 API） | 不用配：`EMBEDDING_MODEL` 填 `BAAI/bge-m3` 这类 Workers AI 上有的向量模型，嵌入**直接走 Cloudflare 自带的 Workers AI**，不去问第三方平台 |
| 想让嵌入固定走另一个平台 | 加 `EMBEDDING_API_URL` + `EMBEDDING_API_KEY`（另一个能嵌入的平台），`EMBEDDING_MODEL` 填它的向量模型 |

判定顺序：`EMBEDDING_PROVIDER` 说了算 → 模型 ID 带 `@cf/` 就是 Workers AI → 配了 `EMBEDDING_API_URL` 就走那个嵌入平台 → `BAAI/bge-m3` 这类 Workers AI 上有的向量模型走 Workers AI → 其余走 `API_URL` 那个平台。

> Workers AI 上的向量模型：bge 系列（`bge-m3`、`bge-large-zh-v1.5`、`bge-small-zh-v1.5`、`bge-base-zh-v1.5`、英文版四种）与 `multilingual-e5-large`。模型名和平台对不上时也不怕——`BAAI/bge-m3`、`bge-m3`、`@cf/baai/bge-m3` 指的都是同一个模型。

### 单独一个嵌入平台

| 变量 | 填什么 |
| --- | --- |
| `EMBEDDING_API_URL` | 嵌入平台根地址，例如 `https://api.siliconflow.cn/v1` |
| `EMBEDDING_API_KEY` | 那个平台的密钥（**Secret**） |
| `EMBEDDING_MODEL` | 它的向量模型，例如 `BAAI/bge-m3` |
| `EMBEDDING_DIMENSIONS` | 它的实际维度（bge-m3 = 1024）。已知模型不用填，Worker 自己算 |

配了 `EMBEDDING_API_URL` 就以它为准，哪怕模型名是 Workers AI 上的那个。

### Workers AI

- 走 Worker 上的 **AI 绑定**，绑定声明在 `wrangler.jsonc` 里（`"ai": { "binding": "AI" }`），**每次部署都自动带上**——控制台不用手动加绑定，重新部署也不会把它冲掉；
- **不需要额外的模型密钥，也不用给 API Token 加任何权限**；
- 模型 ID 以 `@cf/` 开头，或者填的是 Workers AI 上有的向量模型（`BAAI/bge-m3` 这类），就**只走这条路**，不再问第三方平台（写 `BAAI/bge-m3` 会自动补成 `@cf/baai/bge-m3`）；
- **第三方平台上没有这个向量模型时，会自动改走这条路**——不用改 `EMBEDDING_MODEL`，也不用改 `EMBEDDING_DIMENSIONS`（bge-m3 在两边都是 1024 维）；
- bge-m3 最长 512 token，超长片段自动切开分别嵌入后取平均，尾巴不丢；
- 右上角齿轮里的「服务状态」会显示「嵌入 BAAI/bge-m3 · 1024 维 · Workers AI」，一眼看出走的是哪条路。

> 只有回答问题（生成）必须走第三方平台，Worker 里没有对话模型。嵌入这条走 Workers AI 就行，不用再找一个向量平台。

## 配置项

**环境变量以控制台为唯一来源。** 默认值写在 `src/lib/config.js` 里，控制台设了同名变量就以控制台的为准；`wrangler.jsonc` 不声明 `vars` 并打开 `keep_vars`，所以 **GitHub 每次触发重新部署都不会改动你已设好的变量与 Secret**。

控制台路径：**Workers & Pages → rag-kb → Settings → Variables and Secrets** 添加变量（Text）或密钥（Secret），保存后点 **Retry deployment** 生效。

### 模型与接口

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `API_URL` | `https://api.openai.com/v1` | 第三方接口根地址。域名下没有版本段会自动补 `/v1`；粘完整端点也会被自动截掉 |
| `API_KEY` | 无（Secret） | 第三方平台密钥。没配时问答与入库返回 503 并给出配置指引 |
| `API_KEY_HEADER` | `authorization` | 密钥放在哪个请求头。少数平台要 `x-api-key` 时改这里 |
| `API_KEY_PREFIX` | `Bearer ` | 密钥前缀。平台要裸 Key 时改成空字符串 |
| `API_TIMEOUT_MS` | `60000` | 调用第三方接口的超时（5–300 秒） |
| `CHAT_MODEL` | `gpt-4o-mini` | 生成模型 ID（`deepseek-chat`、`qwen-plus`、`moonshot-v1-8k` 等） |
| `CHAT_MAX_TOKENS` | `1500` | 生成上限（1–4096）。推理模型的思考也吃这份额度，太小会被截成「只有思考没有正文」 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 嵌入模型 ID，填平台上的实际名称（`BAAI/bge-m3`、`@cf/baai/bge-m3` 等） |
| `EMBEDDING_DIMENSIONS` | `1536` | 只在模型不认识时用（平台自研模型）。已知模型的维度由模型名直接算出，不用手动同步 |
| `EMBEDDING_API_URL` | 空 | 嵌入单独走另一个平台时填它的根地址 |
| `EMBEDDING_API_KEY` | 空 | 上面那个平台的密钥；留空则沿用 `API_KEY` |
| `EMBEDDING_PROVIDER` | 空 | 嵌入提供方：`workers-ai` 或 `third-party`。留空按模型名判断（`@cf/` 开头、或 Workers AI 上有的向量模型 = Workers AI） |
| `EMBEDDING_MAX_CHARS` | `400` | 单次送进嵌入模型的字符上限。bge-m3 最长 512 token，超了自动切块后取平均 |
| `EMBEDDING_METRIC` | `cosine` | 距离度量 |

### 切片、检索、抓取与资源

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TOP_K` | `6` | 默认召回片段数，请求里可用 `topK` 覆盖（1–20） |
| `CHUNK_MAX_CHARS` | `600` | 单切片目标长度（字符） |
| `CHUNK_OVERLAP_CHARS` | `120` | 相邻切片重叠，防止句子在边界被切断 |
| `MAX_DOC_CHARS` | `200000` | 单篇文档上限，超出返回 413 |
| `MAX_CONTEXT_CHARS` | `12000` | 拼进提示词的参考资料总长度上限 |
| `FETCH_TIMEOUT_MS` | `8000` | 网址抓取单跳超时（2–30 秒） |
| `FETCH_MAX_BYTES` | `800000` | 网址抓取正文大小上限，超了边读边中断 |
| `ALLOW_PRIVATE_URLS` | `false` | 设为 `true` 才允许抓本机/内网网址，仅供调试；元数据地址不受它影响 |
| `DB_NAME` | `rag-kb-db` | D1 数据库名，初始化按这个名字创建/查找 |
| `INDEX_NAME` | `rag-kb-index` | Vectorize 索引名 |
| `CF_API_BASE` | `https://api.cloudflare.com/client/v4` | 内部用，一般不用改 |
| `ACCOUNT_ID` | 空 | 备用；优先读 Secret `CLOUDFLARE_ACCOUNT_ID` |

除上表的键，Worker 还需要三个 Secret：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`ADMIN_TOKEN`。

想永久改默认值就改 `src/lib/config.js` 里的 `DEFAULTS` 再提交；只想调这一个 Worker，在控制台加同名变量即可。

## 换模型 / 换维度

**只换生成模型**（`CHAT_MODEL`）不影响已有向量，改完部署即可。

**换嵌入模型**会改变向量维度，旧向量无法迁移。但正文都存在 D1 里，**不需要删掉文档重新上传**：在控制台改掉 `EMBEDDING_MODEL` 并重新部署，再点**初始化资源**——

- 索引维度与新模型一致 → 跳过，什么都不做；
- 维度对不上 → 页面出现「还差一步：重建向量索引」，Worker 会先探一次新模型的维度（确认真能出这个维度，不符就在删索引之前拦住），然后删掉旧索引、按新维度重建，并拿库里的正文重新嵌入。片段多到一次做不完会自动分批接着做，页面上能看到进度。

换第三方平台时通常还要一起改 `API_URL`、`API_KEY`，有时还有 `API_KEY_HEADER` / `API_KEY_PREFIX`。

常用嵌入模型的维度：`text-embedding-3-small` = 1536、`text-embedding-3-large` = 3072、`BAAI/bge-m3` = 1024、`BAAI/bge-large-zh-v1.5` = 1024、`Qwen3-Embedding-8B` = 4096。**这些维度和模型名是一一对应的，Worker 自己认，换模型不用手动改 `EMBEDDING_DIMENSIONS`**；只有平台自研模型才要手填。**维度填错会在入库时报「向量维度不匹配」**，改对后重建索引即可。

## 工作原理

### 入库时如何优化资料

粘贴的网页、Word、PDF 转出的文本常带一堆排版噪声，直接切片会污染召回。入库前 `src/lib/clean.js` 做一轮**纯规则**清洗（不调模型，不改写事实，不消耗额度）：

- **去噪声行**：面包屑、`返回顶部`、`分享 收藏 点赞`、版权声明、`第 3 页` 页码、`第一章 总则…… 12` 目录点线、markdown 表格分隔行；
- **去页眉页脚**：同一短行出现 3 次以上即判定为页眉或水印；
- **合并断行**：PDF/Word 断开的句子按语义接回（英文跨行断词 `exam-\nple` 也拼回）；
- **展开行内标记**：`[开票指南](url)` 只留文字，`![图](url)` 只留 alt，`<br>` 等标签去掉，实体还原；
- **注入章节路径**：识别 markdown 标题、`第X条`、`一、`、`2.1` 等序号，把所属章节写进每个片段开头（如 `【一、发票开具】\n电子发票在订单完成后…`）。

删除策略刻意保守：只有**整行**都是噪声词、或短行（≤40 字且不以句号结尾）命中强噪声特征时才删。所以正文里的「本文件版权所有，未经授权不得转发。」会完整保留，页脚的「版权所有 侵权必究」会被清掉。清洗后的文本就是库里保存的文本。

### 提问是怎么召回的

只靠向量检索最常见的失败是「问得具体、答得跑偏」：向量对**同义改写**很灵，但对专有名词、条款号、数字和日期几乎不敏感。所以 `/api/ask` 走**两路召回 + 本地重排**，全程不调模型：

1. **向量召回**：问题嵌入后查 Vectorize，取候选池（`topK × 4`，上限 24）；
2. **关键词召回**：抽检索词，用一条 `LIKE` 打分 SQL 扫 `chunks.content`，把向量漏掉的片段带进候选池（检索词全走绑定参数，不拼字符串）；
3. **重排**：`综合分 = 0.42 × 语义分 + 0.58 × 关键词覆盖率`——词法权重更高，因为「踩到提问里的具体名词」才算真的相关；
4. **门槛**：关键词覆盖 < 12% 且语义分 < 0.45 的片段直接丢弃，宁可不答也不喂垃圾资料；
5. **去重**：相邻切片有重叠尾巴，同时入选时抹掉重复部分；
6. **按文档组织引用**：同一篇文档的多个片段并成一个引用块（`【1】《财务手册》（片段 2、3）`），编号对应**文档**而不是片段，模型不会把同一段内容当成两条互相印证的独立证据；
7. **答不出来就明说**：一个片段都没过门槛时不调模型，直接说「知识库中没有足够相关的资料」，并给出实测的最高命中率与三种改问法。提示词同时禁止模型写出资料里没出现过的数字、日期、金额、名称和条款号。

边界：关键词那一路是 `chunks` 全表扫描，片段上万后每次提问多花几十到几百毫秒，长期扩库建议换 D1 FTS5 或给 Vectorize 加 metadata 过滤；取词是纯规则，没有分词器，问句里从没有出现过的说法仍要靠向量那一路。

### 上游接口挑形状

不同平台对「请求长什么样」的要求不统一：有的只认 `max_tokens`，推理模型只认 `max_completion_tokens`；有的网关只收「最后一条消息 role 必须是 user」的单条消息。Worker 按上游报错自动换形状重试：

| 上游抱怨 | 换成什么 |
| --- | --- |
| `max_tokens` / `max_completion_tokens` / `temperature` 不认 | 依次试 `max_completion_tokens` → 去掉生成参数 |
| `role must be` / `last message must be user` | 把 system 并进 user，只发一条 → 内容分片 `[{type:"text"}]` |
| 其它报错 | 直接把原因抛出来，不做无谓重试 |

成功过的形状会被记住，同一个网关下一次直接用对的形状。聚合站把上游 4xx 包成 5xx 时，Worker 会从文本里挖出真实状态码，不会笼统报成「上游服务异常，等一会儿重试」。

## 用网址入库

在「添加知识」里填网址，点**抓取并入库**。抓取在 **Worker 内**完成（浏览器直接 fetch 别人的站会被 CORS 拦），只抓你填的那一个页面，不做整站爬取。流程：抓取 → `<article>`/`<main>`/`<body>` 取正文 → 去标签与实体还原 → [规则清洗](#入库时如何优化资料) + 结构化切片 → 写库。文档名默认取 `og:title`，没有就用 `<title>`，再没有用域名。

防护与边界：

- **超时**：单跳最多 `FETCH_TIMEOUT_MS`（默认 8 秒），超了返回 504 并提示可调；
- **内网拦截**：非 http/https、带账号密码、`localhost`/`*.local`/`*.internal`，以及 `127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`100.64/10`、`169.254/16`、`0.0.0.0/8`、组播段与 IPv6 私网/链路本地地址一律 400 拒绝；十进制、十六进制、短写形式的 IPv4 会先归一化成点分十进制再判断；
- **元数据地址永远不放行**（`169.254.0.0/16` 含云厂商 `169.254.169.254`），不受任何开关影响；
- **重定向逐跳复验**：最多跟 3 跳，每一跳的 `Location` 都重新校验，防止「公网 302 到内网」；
- **大小限制**：先看 `Content-Length`，再边读边累计，超 `FETCH_MAX_BYTES`（默认 800 KB）立即中断返回 413；
- **只收文本**：PDF / Word / 图片 / `octet-stream` 一律 415；非 2xx 翻成中文提示（401/403 → 需要登录或反爬，404 → 页面不存在，429 → 被限流）。

已知限制：靠 JavaScript 渲染的页面（SPA、滚动加载正文）抓不到，返回 422 并提示改用「粘贴正文」；需要登录的站点抓不到。Workers 无法在抓取前做 DNS 解析，理论上存在 DNS rebinding 与 `1.2.3.4.nip.io` 这类把内网 IP 编进域名的服务——知识库若开放给他人，建议给 Worker 加上 Access。

## 常见问题

**页面提示「缺少 Cloudflare API 凭据」/ 状态里 `provision.credentials` 为 false**
两个 Secret 没生效。确认名称拼写正确、类型是 **Secret** 而不是 Text，然后 Retry deployment。

**页面提示「还差一步：配置模型接口」/ 状态里 `llm_ready` 为 false**
`API_URL` 或 `API_KEY` 没配好。加 `API_URL`（Text）和 `API_KEY`（**Secret**），保存后 Retry deployment，再点页面上的「重新检查」。

**入库报「向量维度不匹配」**
模型实际输出的维度与索引维度对不上。已知模型的维度 Worker 自己算（`bge-m3` = 1024、`text-embedding-3-small` = 1536），对不上说明索引还是旧的：点**初始化资源**按新模型重建。若是平台自研模型，把 `EMBEDDING_DIMENSIONS` 填成它的实际维度，再重建。

**入库报「第三方平台没有这个嵌入模型」/ `Embedding model not found`**
入库要的是**向量**，模型 ID 填成了聊天模型（DeepSeek / GPT / Claude 这类只能回答问题），或这个平台上根本没有这个嵌入模型。报错里会列出平台上可用的嵌入模型（Worker 自己去 `/models` 拉的清单），照着换即可；`EMBEDDING_MODEL` 和 `CHAT_MODEL` 必须是两个不同的模型。

**报错说「这个平台的清单里一个向量模型都没有」**
这个平台只提供对话模型。若 `EMBEDDING_MODEL` 填的是 Workers AI 上也有的向量模型（bge 系列等），Worker 会自动改走 Workers AI，这条提示可以直接忽略；想固定走别的平台，就配 `EMBEDDING_API_URL` + `EMBEDDING_API_KEY`。见[嵌入走哪儿](#嵌入走哪儿)。

**报错说「没有可用渠道支持模型 X」**
模型 ID 不在平台登记的名单里，通常是少了渠道后缀（`DeepSeek-V4-Flash(AMD)`）。报错里会列出平台 `/models` 的完整清单，照抄一个即可。若报的是嵌入模型（HTTP 503），说明这个平台没有该**向量**模型——`/embeddings` 地址本身没错，错的是模型；Workers AI 上有同一个模型时会自动改走。

**报错说「Workers AI 上没有 X 这个模型」**
模型名不在 Workers AI 上（向量模型一般只认 `@cf/` 开头的名字）。报错里会列出常用的几个，改 `EMBEDDING_MODEL` 指过去即可，维度不用动。

**报错说「这个 Worker 没有绑定 Workers AI（AI）」**
仓库根目录的 `wrangler.jsonc` 里少了 `"ai": { "binding": "AI" }`，或者这次部署用的不是仓库里的配置。补上后点 **Deployments → 最新一次 → Retry deployment**。

**问答报「第三方接口鉴权失败（HTTP 401）」**
Key 不对、过期或账户没余额。核对有没有多复制引号或空格；确认这个 Key 有权调用你配的 `EMBEDDING_MODEL` / `CHAT_MODEL`；部分平台要求 Key 形如 `sk-…`。

**问答报「第三方接口地址或模型不存在（HTTP 404）」**
两种可能：`API_URL` 少了版本段（应为 `https://xxx/v1` 这样的根地址），或模型 ID 在这个平台上不存在。先用 curl 在本地试一次：

```bash
curl -s https://你的接口/v1/embeddings -H 'authorization: Bearer 你的KEY' \
  -H 'content-type: application/json' -d '{"model":"你的嵌入模型","input":"测试"}'
```

**问答报「第三方接口限流或额度不足（HTTP 429）」**
平台按分钟限流或账户余额见底。等一会儿重试或在平台充值；嵌入与生成分别计费，批量入库时尤其容易撞到嵌入的限额。

**问答报「第三方接口拒绝了这次请求（HTTP 400）」/ 上游说 `Role must be in [...]`**
多半是某个生成参数这个平台不认。Worker 已逐级降级：先发 `{model, messages, temperature, max_tokens}`，被拒就改 `max_completion_tokens`，再被拒就只发 `{model, messages}`。若连最简请求都被拒，看提示里的请求地址，确认 `API_URL` 指向的是 OpenAI 兼容的接口根地址而不是某个网页。报错里出现「所有渠道均失败」说明你在用聚合站——它逐个渠道转发，每个渠道支持的模型与请求格式都不一样。

**报「思考过程没写完就被截断，正文为空」**
推理模型（DeepSeek-R1 之类）先输出思考再给正文，思考的 token 也算在 `CHAT_MAX_TOKENS` 里，太长就被截成「只有思考没有正文」。按提示把它调到 2500–3000；换用非推理模型时设回 900 就够。正常情况下 Worker 会把思考块剥掉只留正文。

**回答不准 / 漏信息 / 答非所问**
先看来源卡上的 `关键词命中`：

- 命中率低、来源却是无关文档 → 提问用的词和文档里的说法不一致。把提问改成文档里的原词（专有名词、条款号、数字写全），例如「跨月发票怎么弄」改成「跨月的红字确认单怎么处理」。
- 来源里根本没有目标文档 → 资料可能没入库，或清洗后没留下正文，去知识库管理确认片段数；必要时把「召回片段数」调到 10。
- 返回「知识库中没有足够相关的资料」→ 这是刻意的：没有片段过相关门槛时不调模型，按提示里的三种改问法重试。
- 来源对但回答漏细节 → 长文档按主题拆成多篇（章节路径会注入每个片段，有助于定位），或调大 `CHUNK_MAX_CHARS`。

**抓不到正文 / 报 422**
只有服务端返回的 HTML 抓得到；靠 JavaScript 现渲染的页面（大多数 SPA、需要登录的站点）抓不到。返回 422 并提示改用「粘贴正文」——浏览器里全选复制即可。

**能上传 PDF / Word 吗？**
不能，接口返回 415 并说明原因：Worker 里没有可靠的二进制解析。请先导出为 `.md` 或 `.txt`（`pandoc in.docx -t gfm -o out.md`）。

**入库报「单个 Worker 调用的子请求数已达上限」/ `Too many subrequests`**
Workers 每次请求的**子请求**有硬额度：免费版 50 个、付费版 1000 个。一次入库的子请求数 ≈ `1（抓页面）+ 片段数 ÷ 16（嵌入）+ 片段数 ÷ 50（写向量）+ 若干（写 D1）`，几百片段的长文档在免费版会撞墙。代码侧已把 D1 写入合批（60 个片段从 61 次请求降到 1 次），仍然超限时的办法：升级 Workers Paid（不用改代码）、把长文档拆成几次入库、或调大 `CHUNK_MAX_CHARS` 减少片段数。

**D1 报 `Invalid input: Expected object, received array`**
D1 的公开 REST 端点只认 `{sql, params}` 或 `{batch: [...]}`，顶层必须是对象（Cloudflare 内部绑定用的裸数组是绑定格式）。本项目已按 `{batch: […]}` 合批写入；若响应里出现 `d1Sequential`，说明该端点在你的账号上仍拒批量请求体，Worker 会自动退回逐条执行，功能不受影响。

**额度**
Workers 免费计划含每天 10 万次请求；Vectorize 免费计划可建索引并存放有限向量。模型费用走**第三方平台**：嵌入按 token 计（一次入库 ≈ 片段数 × 数百 token），生成按 token 计（每次提问约 6–8k 输入 + ≤1.5k 输出）。规模化前请在平台控制台核对配额与单价；部分平台赠送的新客额度够小规模试用，但**嵌入与生成分别计费**，批量入库时嵌入那项往往先见底。

**忘了 `ADMIN_TOKEN`**
它只以 Secret 形式存在 Worker 侧，无法查看。在控制台 Settings 里删掉再设一个新值，点页面右上角齿轮填新值即可，知识库数据不受影响。

**GitHub 触发重新部署后，控制台里设的变量/密钥被冲掉了？**
不会。`wrangler.jsonc` 里不声明 `vars`（默认值在 `src/lib/config.js`）并打开了 `keep_vars`，部署只上传代码；Secret 也不会被部署删除。只有两种情况会改值：在控制台主动改了，或在 GitHub 仓库里配了 `API_KEY`（工作流会用它覆盖同名 Secret；不配就完全不动）。

## 本地开发

前置：Node ≥ 22。

```bash
npm install
npm run preview      # → http://127.0.0.1:8790 ，访问令牌 mock-token
```

`preview` 是**离线端到端模拟**：内存版 D1 + 向量库 + 假的 OpenAI 兼容接口 + 假的 Cloudflare REST API（同一进程，端口 8791），「初始化资源 → 入库 → 问答 → 删除」整条真实代码路径都能在完全不登录、不花额度的情况下跑通。数据重启即清空，还自带一个可抓取的示例页（`http://127.0.0.1:8790/fixture/redirect`）。

想调真实资源：

```bash
cp .dev.vars.example .dev.vars    # 填几个 Secret 的值
npx wrangler login
npm run dev                       # wrangler dev --remote
```

`npm run dev` 连的是**你账号里真实的** D1 / Vectorize，并会真的调用你配置的第三方接口。日常调试建议用 `preview`。

其他脚本：

```bash
npm test              # 单元与逻辑测试：切片 / 清洗 / 向量序列化 / 网址抓取拦截 / 模型接口层
npm run check         # 全部 JS 语法检查
npm run schema:dump   # 由 src/lib/schema.js 重新导出 schema.sql
npm run deploy        # 只部署代码，不建资源
```

## HTTP API

```bash
BASE=https://rag-kb.<子域>.workers.dev
AUTH='authorization: Bearer <ADMIN_TOKEN>'

# 状态（唯一免鉴权接口）：是否已初始化、文档/片段数、生效配置
curl -s $BASE/api/status
# → {"ok":true,"provisioned":false,"llm_ready":true,"config":{"embedding_model":"@cf/baai/bge-m3","embedding_provider":"workers-ai",…}}

# 初始化资源（幂等）：建 D1 库 + 两张表 + Vectorize 索引
curl -s -X POST $BASE/api/admin/setup -H "$AUTH"

# 重建索引后续跑：一次 Worker 调用做不完所有片段时，前端拿着 offset 一批批接着做
curl -s -X POST $BASE/api/admin/reembed -H "$AUTH" -H 'content-type: application/json' -d '{"offset":150}'
# → {"ok":true,"total":420,"processed":150,"offset":300,"remaining":120}

# 入库（粘贴文本 / 抓网页）
curl -s -X POST $BASE/api/documents -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"退货政策","text":"退货申请需在签收后七天内提交……"}'
curl -s -X POST $BASE/api/documents -H "$AUTH" -H 'content-type: application/json' \
  -d '{"url":"https://example.com/help/return-policy"}'
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
# → {"answer":"…[1]","sources":[{"index":1,"docId":"…","title":"退货政策","chunks":[2],"score":0.82,"vector":0.61,"lexical":0.9,"excerpt":"…"}],"timings":{"candidates":13,"totalMs":120},"usage":{"prompt_tokens":820,"completion_tokens":96,"total_tokens":916},"model":"gpt-4o-mini","terms":["退货申请","提交"]}
```

除 `/api/status` 外全部要求令牌；出错时返回 `{"error":"中文说明","details":{"hint":"下一步该做什么"}}`。上游第三方接口的失败也会被翻成中文提示（401/403 → 鉴权失败，404 → 地址或模型不存在，429 → 限流或额度不足），`details.hint` 里直接写清楚下一步该改什么。

## 安全说明

- **访问令牌强制**：Worker 持有的 API Token 能创建/删除资源，因此除 `/api/status` 外所有接口都要求 `Authorization: Bearer <ADMIN_TOKEN>`，未设置该 Secret 时直接返回 403 并给出配置指引。令牌比较走 `crypto.timingSafeEqual`。
- **Token 最小化**：只授予上面那几项权限，不要塞 Global Key 或 Zone 权限；这个 Token 会随每次请求出现在 Worker 的出站头里。
- **不会被注入**：文档正文、回答与来源一律用 `textContent` 渲染，不执行任何 HTML；SQL 全部走占位符参数。
- **有上限**：请求体、单篇文档长度、召回片段数都有边界，PDF 等二进制直接拒收。
- **抓取不越界**：网址入库只走 http/https、只跟 3 跳且逐跳复验，内网、回环、链路本地与组播地址一律拒绝，云厂商元数据段不受任何开关影响；出站请求只带公开的 UA 与 Accept 头，**不会携带 `ADMIN_TOKEN` 或 Cloudflare API Token**。
- 建议给 Worker 域名开启访问控制（Zero Trust / Access），或至少保持 `ADMIN_TOKEN` 足够长。

## 项目结构

```
wrangler.jsonc           只声明 Assets 绑定、AI 绑定与 keep_vars，不声明 d1 / vectorize 绑定
schema.sql               由 src/lib/schema.js 导出的建表 SQL（仅作参考，运行时不读）
src/index.js             路由、鉴权、参数校验，唯一的 HTTP 入口
src/lib/config.js        环境变量默认值与合并规则（控制台的值优先）
src/lib/cfapi.js         Cloudflare REST API 封装：D1 建库/查询、Vectorize 建索引/NDJSON 写入/检索/删除
src/lib/setup.js         「初始化资源」的幂等逻辑与 provisioning 状态探测
src/lib/store.js         通过 REST 读写 D1（切片原文按向量 id 回查）
src/lib/llm.js           第三方 OpenAI 兼容接口：地址归一化、嵌入/生成调用、错误翻成中文提示
src/lib/models.js        已知向量模型的维度表与 Workers AI 模型清单（维度按模型名算）
src/lib/workersai.js     Workers AI 向量模型：走 Worker 上的 AI 绑定，长文本切块后取平均
src/lib/rag.js           嵌入、批量 upsert、向量检索、维度校验
src/lib/rank.js          检索词抽取、关键词召回 SQL、两路分数合并重排、重叠去重
src/lib/chunk.js         中英混合文本切片（段落 → 句子 → 重叠打包）与标题层级识别
src/lib/clean.js         入库前的规则清洗：去噪声行、合并硬断行、展开行内标记
src/lib/grab.js          网址入库：SSRF 拦截、超时与大小上限、HTML 抽正文
src/lib/answer.js        中文系统提示词、上下文拼装、生成调用
src/lib/http.js          JSON 响应、错误包装、请求体解析、令牌校验
src/lib/schema.js        建表 SQL 的唯一来源，schema.sql 由它导出
public/                  问答与知识库管理页面（原生 HTML/CSS/JS，无构建）
fixtures/                示例网页，供本地端到端抓取与测试使用
scripts/dev-mock.mjs     离线端到端模拟，含假的 Cloudflare REST API 与假的模型接口
scripts/dump-schema.mjs  从 src/lib/schema.js 导出 schema.sql
scripts/test.mjs         切片、清洗、网址抓取、检索重排与模型接口层的回归测试
scripts/test-e2e.mjs     端到端回归：初始化 → 入库 → 检索 → 问答 → 索引重建
scripts/check.sh         语法检查
.github/workflows/       附录「GitHub Actions 自动部署」的路径
```

## 附录：命令行部署

习惯本地 wrangler 的话，几条命令等价于上面第 2–3 步（第 4 步仍在浏览器里点按钮，或用前面的 curl）：

```bash
export CLOUDFLARE_API_TOKEN=<Token>
export CLOUDFLARE_ACCOUNT_ID=<Account ID>
npm install
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN    # 交互输入，只写这一个
npx wrangler secret put API_KEY
```

`secret put` 交互输入要写的值，每次只覆盖同名的那一个；不写的那一个保持控制台里的原值，不会被冲成空。

`API_URL` 是普通变量不是密钥，在控制台加一个同名变量即可；部署带着 `keep_vars`，不会动控制台里已有的变量与 Secret。

资源不用建：Worker 第一次执行「初始化资源」时自己通过 Cloudflare REST API 创建 D1 与 Vectorize，`wrangler.jsonc` 里不写死绑定。

## 附录：GitHub Actions 自动部署

仓库自带 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)：push 到 `main` 时跑语法检查与离线测试，然后 `wrangler deploy`。它**只部署代码**，不建资源（资源由 Worker 自己在页面里创建），因此只需要三个 Secret：

仓库 → Settings → Secrets and variables → Actions → New repository secret：

```
CLOUDFLARE_ACCOUNT_ID   = 你的 Account ID
CLOUDFLARE_API_TOKEN    = 权限见第 3 步表格
API_KEY                 = 第三方平台密钥（可留空）
```

`ADMIN_TOKEN` 与 `API_URL` 不在这个列表里：`ADMIN_TOKEN` 在控制台手动设一次即可，`API_URL` 是普通变量，也在控制台设（`wrangler.jsonc` 里不声明 `vars`，控制台就是唯一来源）。

`API_KEY` 可留空：留空时工作流**跳过写入**，控制台里手工设的值原样保留；填了则以仓库里的为准（这是 GitOps 的本意）。

> **每次 push 触发的重新部署都不会覆盖你设过的环境变量。** `wrangler.jsonc` 里没有 `vars` 并打开了 `keep_vars`，部署只上传代码；Secret 也不会被部署删除，只有显式执行 `wrangler secret put` 才会覆盖某一个。

与控制台连 Git 二选一即可，同时启用会互相覆盖同一个 Worker。
