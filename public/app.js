const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "rag-kb-token";
const MODE_LABELS = { paste: "入库正文", file: "上传并入库", url: "抓取并入库" };
const ORIGIN_LABELS = { upload: "文件上传", paste: "粘贴", url: "网址抓取" };

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  status: null,
  counts: null,
  documents: [],
  mode: "paste",
  filter: "",
};

class ApiError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.hints = hints;
  }
}

function toHints(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    throw new ApiError(`网络请求失败：${error.message}`);
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = body?.details || {};
    throw new ApiError(body?.error || `接口 ${path} 返回 HTTP ${response.status}`, toHints(detail.hint ?? body?.hint));
  }
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(paths, size = 22) {
  const wrap = document.createElement("span");
  wrap.className = "empty-icon";
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return wrap;
}

/* ---------------- 提示浮层 ---------------- */
function toast(message, kind = "info") {
  const box = el("div", `toast${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}`);
  box.appendChild(el("span", "toast-text", message));
  const close = el("button", "toast-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  const remove = () => {
    box.remove();
    clearTimeout(timer);
  };
  close.addEventListener("click", remove);
  box.appendChild(close);
  $("toasts").appendChild(box);
  const timer = setTimeout(remove, kind === "error" ? 9000 : 4200);
  return box;
}

function showNotice(target, error) {
  const hints = error instanceof ApiError ? error.hints : [];
  target.textContent = "";
  target.appendChild(el("div", "notice-title", error.message));
  if (hints.length) {
    const list = el("ul", "notice-list");
    for (const hint of hints) list.appendChild(el("li", "", hint));
    target.appendChild(list);
  }
  target.classList.remove("hidden");
}

function clearNotice(target) {
  target.textContent = "";
  target.classList.add("hidden");
}

function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText || "处理中…";
    button.classList.add("is-busy");
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    delete button.dataset.label;
    button.classList.remove("is-busy");
    button.disabled = false;
  }
}

// 模型接口没配好时，问答与入库都不可用：按钮置灰，把原因写在 title 与顶部横幅里
function applyReadiness() {
  const ready = Boolean(state.status?.llm_ready);
  for (const id of ["askBtn", "ingestBtn"]) {
    const button = $(id);
    if (button.classList.contains("is-busy")) continue;
    button.disabled = !ready;
    button.title = ready ? "" : "先在页面上方配置第三方模型接口（API_URL / API_KEY）";
  }
}

/* ---------------- 状态栏 ---------------- */
function renderStatus() {
  const status = state.status;
  const chips = $("statChips");
  chips.textContent = "";
  if (!status) {
    $("statusLine").textContent = "正在连接服务…";
    return;
  }

  const parts = [];
  if (state.counts) parts.push(`${state.counts.docs} 篇文档 · ${state.counts.chunks} 个片段`);
  if (status.config.api_host) parts.push(`接口 ${status.config.api_host}`);
  // 嵌入单独走另一个平台时，把它的地址也摆出来，别让人以为走的是同一个
  if (status.config.embedding_api_host && status.config.embedding_api_host !== status.config.api_host) {
    parts.push(`嵌入接口 ${status.config.embedding_api_host}`);
  }
  // 嵌入走的是 Workers AI 还是第三方平台，说清楚
  const provider = status.config.embedding_provider === "workers-ai" ? " · Workers AI" : "";
  parts.push(`嵌入 ${status.config.embedding_model}（${status.config.embedding_dimensions} 维${provider}）`);
  parts.push(`生成 ${status.config.chat_model}`);
  $("statusLine").textContent = parts.join(" · ");

  const dot = (cls) => el("span", `chip-dot ${cls}`);
  const ready = status.provisioned && status.llm_ready;
  const readyChip = el("span", "chip");
  readyChip.append(dot(ready ? "is-ok" : "is-warn"), document.createTextNode(ready ? "服务就绪" : "待配置"));
  chips.appendChild(readyChip);

  if (state.counts) {
    const docs = el("span", "chip");
    docs.append(el("b", "", String(state.counts.docs)), document.createTextNode(" 篇文档"));
    chips.appendChild(docs);
  }

  const model = el("span", "chip", status.config.chat_model);
  model.title = `嵌入 ${status.config.embedding_model} · 生成 ${status.config.chat_model}`;
  chips.appendChild(model);

  const auth = el("span", "chip");
  auth.append(dot(status.auth_required ? "is-ok" : "is-warn"), document.createTextNode(status.auth_required ? "已鉴权" : "未设令牌"));
  chips.appendChild(auth);
}

function renderBanners() {
  const status = state.status;
  const host = $("banners");
  host.textContent = "";
  host.hidden = true;
  if (!status) return;

  const banner = (title, text, options = {}) => {
    const box = el("div", `banner${options.warn ? " is-warn" : ""}`);
    const body = el("div", "banner-body");
    body.appendChild(el("div", "banner-title", title));
    const paragraph = el("div", "banner-text");
    for (const part of options.parts || [text]) {
      const line = el("p");
      for (const chunk of String(part).split(/(`[^`]+`)/)) {
        if (chunk.startsWith("`") && chunk.endsWith("`")) {
          line.appendChild(el("code", "banner-code", chunk.slice(1, -1)));
        } else if (chunk) {
          line.appendChild(document.createTextNode(chunk));
        }
      }
      paragraph.appendChild(line);
    }
    body.appendChild(paragraph);
    box.appendChild(body);
    if (options.action) {
      const actions = el("div", "banner-actions");
      const button = el("button", `btn ${options.action.primary === false ? "btn-ghost" : "btn-primary"}`, options.action.label);
      button.type = "button";
      button.addEventListener("click", options.action.onClick);
      actions.appendChild(button);
      box.appendChild(actions);
    }
    host.appendChild(box);
    host.hidden = false;
  };

  if (!status.llm_ready) {
    banner("还差一步：配置模型接口", "", {
      parts: [
        "回答问题走你自己的第三方模型接口，请在 Workers 控制台 Settings → Variables and Secrets 里添加：",
        "变量 API_URL —— 第三方平台的接口根地址，例如 https://api.openai.com/v1",
        "Secret API_KEY —— 第三方平台的密钥",
        "入库用的嵌入默认走同一个平台；那个平台上没有向量模型时，会自动改走 Cloudflare 自带的 Workers AI，不用另配密钥，也不用改 EMBEDDING_MODEL。",
        "改完点 Retry deployment 重新部署，再回来点「重新检查」。",
      ],
      action: { label: "重新检查", primary: false, onClick: () => loadStatus() },
    });
  }

  if (!status.provisioned) {
    const missing = [];
    if (!status.provision.credentials) missing.push("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID");
    if (!status.provision.database) missing.push(`D1 数据库 ${status.config.database_name}`);
    if (!status.provision.tables) missing.push("documents / chunks 两张表");
    if (!status.provision.index) missing.push(`Vectorize 索引 ${status.config.index_name}`);
    const mismatch = status.provision.index?.mismatch;
    banner(mismatch ? "还差一步：重建向量索引" : "还差一步：初始化资源", "", {
      parts: mismatch
        ? [
            `索引 ${status.config.index_name} 是 ${status.provision.index.dimensions} 维，与模型 ${status.config.embedding_model} 的 ${status.config.embedding_dimensions} 维不符，向量检索会用不了。`,
            "重建会删掉旧索引，按当前模型新建，并拿库里保存的正文重新嵌入——文档不用重新上传。",
          ]
        : [
            `缺少：${missing.join("、")}。`,
            status.provision.credentials
              ? "点右侧按钮，Worker 会自己建库、建表、建向量索引，几秒钟完成，重复点不会重复创建。"
              : "先在 Workers 控制台添加 CLOUDFLARE_API_TOKEN 与 CLOUDFLARE_ACCOUNT_ID 两个 Secret，再回来点按钮。",
          ],
      action: { label: mismatch ? "重建索引" : "初始化资源", onClick: runSetup },
    });
  }

  if (!status.auth_required) {
    banner("还没有配置访问令牌", "", {
      warn: true,
      parts: [
        "除状态查询外，所有接口都要求令牌。请在 Workers 控制台添加 Secret ADMIN_TOKEN，",
        "然后在页面右上角填入同一个值并保存。",
      ],
    });
  }
}

/* ---------------- 回答与来源 ---------------- */
function focusSource(index) {
  const box = document.getElementById(`source-${index}`);
  if (!box) return;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  box.classList.add("is-flash");
  setTimeout(() => box.classList.remove("is-flash"), 1800);
}

function renderAnswer(target, text, hasSources) {
  target.textContent = "";
  for (const part of String(text).split(/(\[\d+\])/g)) {
    if (/^\[\d+\]$/.test(part)) {
      const chip = el("button", "cite", part);
      chip.type = "button";
      chip.title = "跳到对应来源";
      chip.addEventListener("click", () => focusSource(Number(part.slice(1, -1))));
      target.appendChild(chip);
    } else if (part) {
      target.appendChild(document.createTextNode(part));
    }
  }
  if (!hasSources) {
    target.appendChild(el("p", "muted answer-empty", "（本次没有召回到任何片段）"));
  }
}

function renderSources(target, sources) {
  target.textContent = "";
  if (!sources?.length) {
    const empty = el("div", "empty");
    empty.appendChild(svgIcon('<path d="M4 5h16v14H4z"/><path d="M8 10h8M8 14h5"/>'));
    empty.appendChild(el("div", "empty-title", "没有引用来源"));
    empty.appendChild(el("div", "empty-text", "这次提问没有召回到足够相关的片段。可以换成资料里的原词再问一次，或调大「召回片段」。"));
    target.appendChild(empty);
    return;
  }

  for (const source of sources) {
    const box = el("div", "source");
    box.id = `source-${source.index}`;

    const head = el("div", "source-head");
    head.appendChild(el("span", "source-num", String(source.index)));
    head.appendChild(el("span", "source-title", source.title));
    const tags = el("div", "source-tags");
    tags.appendChild(el("span", "tag tag-score", `综合 ${source.score.toFixed(3)}`));
    tags.appendChild(el("span", "tag tag-chunk", `片段 ${source.chunks.join("、")}`));
    head.appendChild(tags);
    box.appendChild(head);

    const meter = el("div", "source-meter");
    const fill = el("span");
    fill.style.width = `${Math.max(4, Math.min(100, source.score * 100))}%`;
    meter.appendChild(fill);
    box.appendChild(meter);

    const excerpt = source.excerpt || "";
    box.appendChild(el("p", "source-excerpt", excerpt + (excerpt.length >= 300 ? " …" : "")));

    const detail = el("div", "source-detail");
    const add = (label, value) => {
      const item = el("span");
      item.append(`${label} `, el("b", "", value));
      detail.appendChild(item);
    };
    add("语义分", source.vector.toFixed(3));
    add("关键词命中", `${Math.round(source.lexical * 100)}%`);
    box.appendChild(detail);

    target.appendChild(box);
  }
}

function renderMeta(data) {
  const host = $("askMeta");
  host.textContent = "";
  const item = (label, value, warn = false) => {
    const node = el("span", `meta-item${warn ? " is-warn" : ""}`);
    node.append(el("b", "", label), document.createTextNode(value));
    return node;
  };
  host.appendChild(item("候选", `${data.timings.candidates} 个片段`));
  host.appendChild(item("采用", `${data.sources.length} 个来源`));
  host.appendChild(item("耗时", `${data.timings.totalMs} ms`));
  if (data.usage?.total_tokens) host.appendChild(item("Token", `${data.usage.total_tokens}`));
  if (data.model) host.appendChild(item("模型", data.model));
  if (data.noContext) host.appendChild(item("状态", "资料不足，未调用模型", true));
}

/* ---------------- 文档列表 ---------------- */
function formatTime(value) {
  if (!value) return "";
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderDocs() {
  const target = $("docList");
  target.textContent = "";
  const keyword = state.filter.trim().toLowerCase();
  const docs = keyword ? state.documents.filter((doc) => doc.title.toLowerCase().includes(keyword)) : state.documents;

  if (!state.documents.length) {
    const empty = el("div", "empty");
    empty.appendChild(svgIcon('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/>'));
    empty.appendChild(el("div", "empty-title", "知识库还是空的"));
    empty.appendChild(el("div", "empty-text", "在「添加知识」里粘贴正文、上传文件或填一个网址，资料会被切片、嵌入并写入向量库，之后就能提问了。"));
    target.appendChild(empty);
    return;
  }

  if (!docs.length) {
    const empty = el("div", "empty");
    empty.appendChild(svgIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'));
    empty.appendChild(el("div", "empty-title", "没有匹配的文档"));
    empty.appendChild(el("div", "empty-text", `没有名称包含「${state.filter.trim()}」的文档。`));
    target.appendChild(empty);
    return;
  }

  for (const doc of docs) {
    const row = el("div", "doc");
    const main = el("div", "doc-main");
    main.appendChild(el("div", "doc-title", doc.title));

    const meta = el("div", "doc-meta");
    const origin = el("span", "origin", ORIGIN_LABELS[doc.origin] || doc.origin);
    origin.dataset.origin = doc.origin;
    meta.appendChild(origin);
    meta.appendChild(el("span", "", `${doc.chunk_count} 个片段`));
    meta.appendChild(el("span", "", `${doc.char_count} 字`));
    meta.appendChild(el("span", "", formatTime(doc.created_at)));
    main.appendChild(meta);

    const del = el("button", "btn btn-danger", "删除");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`删除《${doc.title}》及其 ${doc.chunk_count} 个向量片段？`)) return;
      del.disabled = true;
      try {
        await api(`/api/documents/${doc.id}`, { method: "DELETE" });
        toast(`已删除《${doc.title}》`, "success");
        await loadDocs();
      } catch (error) {
        toast(error.message, "error");
        del.disabled = false;
      }
    });

    row.append(main, del);
    target.appendChild(row);
  }
}

function renderFiles() {
  const list = $("fileList");
  list.textContent = "";
  const files = [...$("files").files];
  for (const file of files) {
    const item = el("li");
    item.appendChild(el("span", "file-name", file.name));
    item.appendChild(el("span", "file-size", formatSize(file.size)));
    list.appendChild(item);
  }
}

/* ---------------- 动作 ---------------- */
async function loadStatus() {
  try {
    state.status = await api("/api/status");
    renderStatus();
    renderBanners();
    applyReadiness();
  } catch (error) {
    $("statusLine").textContent = `服务状态获取失败：${error.message}`;
  }
}

async function loadDocs() {
  const target = $("docList");
  try {
    const data = await api("/api/documents");
    state.documents = data.documents || [];
    state.counts = data.counts || null;
    renderDocs();
    renderStatus();
  } catch (error) {
    target.textContent = "";
    showNotice(target, error);
    toast(error.message, "error");
  }
}

// 重建索引后正文要重新嵌入，一次 Worker 调用做不完，分批接着做
async function reembedRest(state) {
  let offset = Number(state.offset) || 0;
  let total = Number(state.total) || 0;
  let remaining = Number(state.remaining) || 0;
  while (remaining > 0) {
    const data = await api("/api/admin/reembed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset }),
    });
    const next = Number(data.offset) || 0;
    if (next <= offset) throw new Error("重新嵌入没有推进，请点「重建索引」重来一次");
    offset = next;
    total = Number(data.total) || total;
    remaining = Number(data.remaining) || 0;
  }
  return total;
}

async function runSetup() {
  const button = $("banners").querySelector(".banner-actions .btn");
  if (button) setBusy(button, true, "初始化中…");
  try {
    const data = await api("/api/admin/setup", { method: "POST" });
    const detail = (data.steps || []).map((step) => `${step.step} ${step.action}`).join(" · ");
    toast(`资源已就绪${detail ? `（${detail}）` : ""}`, "success");
    if (data.reembed?.remaining) {
      const total = await reembedRest(data.reembed);
      toast(`已按新维度重新嵌入 ${total} 个片段`, "success");
    }
    await Promise.all([loadStatus(), loadDocs()]);
  } catch (error) {
    toast(error.message, "error");
    if (button) setBusy(button, false);
  }
}

async function submitAsk() {
  const question = $("question").value.trim();
  if (!question) {
    toast("请先输入问题", "error");
    $("question").focus();
    return;
  }
  const button = $("askBtn");
  setBusy(button, true, "检索中…");
  clearNotice($("askError"));
  try {
    const data = await api("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, topK: Number($("topK").value) }),
    });
    renderAnswer($("answer"), data.answer, data.sources.length > 0);
    renderSources($("sources"), data.sources);
    renderMeta(data);
    $("askResult").classList.remove("hidden");
    $("askResult").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showNotice($("askError"), error);
    $("askResult").classList.add("hidden");
  } finally {
    setBusy(button, false);
  }
}

async function submitIngest() {
  const button = $("ingestBtn");
  const title = $("docTitle").value.trim();
  const pasted = $("pasted").value.trim();
  const files = [...$("files").files];
  const url = $("pageUrl").value.trim();

  let body;
  if (state.mode === "paste") {
    if (!pasted) return toast("请先粘贴要入库的正文", "error");
    body = { title: title || "未命名文档", text: pasted };
  } else if (state.mode === "file") {
    if (!files.length) return toast("请先选择要上传的文件", "error");
    body = { title: title || files[0].name.replace(/\.[^.]+$/, ""), text: await files[0].text() };
  } else {
    if (!url) return toast("请先填写要抓取的网址", "error");
    body = title ? { url, title } : { url };
  }

  setBusy(button, true, "入库中…");
  clearNotice($("ingestError"));
  try {
    const data = await api("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const stats = data.cleaned;
    const optimized = stats && stats.before > stats.after ? `，资料已优化 ${stats.before} → ${stats.after} 字` : "";
    toast(`《${data.title}》已入库，切成 ${data.chunkCount} 个片段${optimized}`, "success");
    $("pasted").value = "";
    $("files").value = "";
    $("pageUrl").value = "";
    $("docTitle").value = "";
    renderFiles();
    await Promise.all([loadDocs(), loadStatus()]);
  } catch (error) {
    showNotice($("ingestError"), error);
  } finally {
    setBusy(button, false);
  }
}

/* ---------------- 事件 ---------------- */
function selectTab(name) {
  for (const tab of document.querySelectorAll(".seg")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("is-active", panel.id === `panel-${name}`);
  }
}

function selectMode(mode) {
  state.mode = mode;
  for (const button of document.querySelectorAll(".mode")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const panel of document.querySelectorAll(".mode-panel")) {
    panel.classList.toggle("is-active", panel.dataset.panel === mode);
  }
  $("ingestBtn").textContent = MODE_LABELS[mode];
  if ($("ingestBtn").dataset.label) $("ingestBtn").dataset.label = MODE_LABELS[mode];
}

document.querySelectorAll(".seg").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", () => selectMode(button.dataset.mode));
});

$("saveToken").addEventListener("click", () => {
  state.token = $("token").value.trim();
  if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
  else localStorage.removeItem(TOKEN_KEY);
  toast(state.token ? "令牌已保存在本地浏览器" : "已清空令牌");
  loadStatus();
  loadDocs();
});

$("token").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("saveToken").click();
});

$("askBtn").addEventListener("click", submitAsk);
$("question").addEventListener("input", (event) => {
  $("questionCount").textContent = `${event.target.value.length} / 2000`;
});
$("question").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAsk();
});

$("copyAnswer").addEventListener("click", async () => {
  const text = $("answer").textContent.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("答案已复制到剪贴板", "success");
  } catch {
    toast("复制失败，请手动选中文本复制", "error");
  }
});

$("ingestBtn").addEventListener("click", submitIngest);
$("pageUrl").addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitIngest();
});
$("files").addEventListener("change", renderFiles);
$("refreshBtn").addEventListener("click", loadDocs);

$("docFilter").addEventListener("input", (event) => {
  state.filter = event.target.value;
  renderDocs();
});

$("token").value = state.token;
selectMode("paste");
loadStatus();
loadDocs();
