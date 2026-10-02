const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "rag-kb-token";

const state = { token: localStorage.getItem(TOKEN_KEY) || "", busy: false };
$("token").value = state.token;

function headers(extra) {
  const h = { ...extra };
  if (state.token) h.authorization = `Bearer ${state.token}`;
  return h;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: headers(options.headers) });
  } catch (error) {
    throw new Error(`网络请求失败：${error.message}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) throw new Error(`接口 ${path} 返回 HTTP ${response.status}`);
    throw new Error(`接口 ${path} 返回了非 JSON 内容`);
  }
  if (!response.ok) {
    const hint = body?.hint || (body?.details?.hint ?? "");
    const lines = Array.isArray(hint) ? hint.join(" ") : hint;
    throw new Error(`${body?.error || `HTTP ${response.status}`}${lines ? `｜${lines}` : ""}`);
  }
  return body;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), isError ? 9000 : 4000);
}

function setBusy(busy, hintEl, text) {
  state.busy = busy;
  if (hintEl) hintEl.textContent = text || (busy ? "处理中，请稍候…" : "");
  $("askBtn").disabled = busy;
  $("ingestBtn").disabled = busy;
}

// 只按 [数字] 拆分并生成节点，正文始终用 textContent 插入，避免文档内容注入 HTML
function renderAnswer(target, text, sourceCount) {
  target.textContent = "";
  const parts = String(text).split(/(\[\d+\])/);
  for (const part of parts) {
    if (/^\[\d+\]$/.test(part)) {
      const span = document.createElement("span");
      span.className = "cite";
      span.textContent = part;
      target.appendChild(span);
    } else if (part) {
      target.appendChild(document.createTextNode(part));
    }
  }
  if (!sourceCount) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "（本次没有召回到任何片段）";
    target.appendChild(note);
  }
}

function renderSources(target, sources) {
  target.textContent = "";
  if (!sources || !sources.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "无引用来源。";
    target.appendChild(p);
    return;
  }
  for (const source of sources) {
    const box = document.createElement("div");
    box.className = "source";

    const head = document.createElement("header");
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `[${source.index}]`;
    const title = document.createElement("strong");
    title.textContent = source.title;
    const score = document.createElement("span");
    score.className = "muted";
    score.textContent = `相似度 ${source.score} · 第 ${Number(source.ordinal) + 1} 段`;
    head.append(num, title, score);

    const excerpt = document.createElement("div");
    excerpt.className = "excerpt";
    excerpt.textContent = source.excerpt + (source.excerpt?.length >= 300 ? " …" : "");

    box.append(head, excerpt);
    target.appendChild(box);
  }
}

function renderDocs(target, documents) {
  target.textContent = "";
  target.classList.remove("muted");
  if (!documents.length) {
    target.classList.add("muted");
    target.textContent = "还没有文档。在上方粘贴或上传内容后点“入库”。";
    return;
  }
  for (const doc of documents) {
    const row = document.createElement("div");
    row.className = "doc";

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = doc.title;
    const stats = document.createElement("div");
    stats.className = "muted";
    stats.textContent = `${doc.chunk_count} 个片段 · ${doc.char_count} 字 · ${doc.origin === "upload" ? "文件上传" : "粘贴"} · ${doc.created_at}`;
    meta.append(title, stats);

    const del = document.createElement("button");
    del.className = "danger";
    del.type = "button";
    del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm(`删除《${doc.title}》及其 ${doc.chunk_count} 个向量片段？`)) return;
      del.disabled = true;
      try {
        await api(`/api/documents/${doc.id}`, { method: "DELETE" });
        toast(`已删除《${doc.title}》`);
        await loadDocs();
      } catch (error) {
        toast(error.message, true);
        del.disabled = false;
      }
    });

    row.append(meta, del);
    target.appendChild(row);
  }
}

async function loadStatus() {
  try {
    const data = await api("/api/status");
    const c = data.config;
    $("statusLine").textContent = `${data.counts.docs} 篇文档 · ${data.counts.chunks} 个片段 · 嵌入 ${c.embedding_model}（${c.embedding_dimensions} 维）${data.auth_required ? " · 已开启鉴权" : " · 未开启鉴权"}`;
    if (data.auth_required && !state.token) toast("该服务开启了鉴权，请在右上角填写访问令牌", true);
  } catch (error) {
    $("statusLine").textContent = `服务状态获取失败：${error.message}`;
  }
}

async function loadDocs() {
  const target = $("docList");
  target.textContent = "加载中…";
  try {
    const data = await api("/api/documents");
    renderDocs(target, data.documents);
  } catch (error) {
    target.classList.add("muted");
    target.textContent = `加载失败：${error.message}`;
  }
}

async function submitAsk() {
  const question = $("question").value.trim();
  if (!question) return toast("请先输入问题", true);
  setBusy(true, $("askHint"));
  try {
    const data = await api("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, topK: Number($("topK").value) }),
    });
    renderAnswer($("answer"), data.answer, data.sources.length);
    renderSources($("sources"), data.sources);
    $("askResult").classList.remove("hidden");
    $("askHint").textContent = `召回 ${data.sources.length} 个片段 · ${data.timings.totalMs} ms`;
    setBusy(false, $("askHint"));
  } catch (error) {
    toast(error.message, true);
    setBusy(false, $("askHint"));
  }
}

async function readFile(file) {
  const text = await file.text();
  return { title: file.name.replace(/\.[^.]+$/, ""), text };
}

async function submitIngest() {
  const pasted = $("pasted").value.trim();
  const files = [...$("files").files];
  if (!pasted && !files.length) return toast("请上传文件或粘贴正文", true);

  const jobs = files.map((file) => ({ title: file.name.replace(/\.[^.]+$/, ""), textPromise: file.text() }));
  if (pasted) jobs.unshift({ title: $("docTitle").value.trim() || "粘贴的文档", textPromise: Promise.resolve(pasted) });

  setBusy(true, $("ingestHint"));
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    $("ingestHint").textContent = `入库中 ${done + failed + 1}/${jobs.length}：${job.title}`;
    try {
      const text = await job.textPromise;
      const data = await api("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: job.title, text }),
      });
      done += 1;
      $("ingestHint").textContent = `《${data.title}》已切成 ${data.chunkCount} 个片段`;
    } catch (error) {
      failed += 1;
      toast(`${job.title} 入库失败：${error.message}`, true);
    }
  }
  setBusy(false, $("ingestHint"));
  $("pasted").value = "";
  $("files").value = "";
  $("docTitle").value = "";
  toast(`入库完成：成功 ${done} 篇${failed ? `，失败 ${failed} 篇` : ""}`, failed > 0 && done === 0);
  await Promise.all([loadDocs(), loadStatus()]);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab.dataset.tab}`));
  });
});

$("saveToken").addEventListener("click", () => {
  state.token = $("token").value.trim();
  if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
  else localStorage.removeItem(TOKEN_KEY);
  toast(state.token ? "令牌已保存在本地" : "已清空令牌");
  loadStatus();
  loadDocs();
});

$("askBtn").addEventListener("click", submitAsk);
$("question").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAsk();
});
$("ingestBtn").addEventListener("click", submitIngest);
$("refreshBtn").addEventListener("click", loadDocs);

loadStatus();
loadDocs();
