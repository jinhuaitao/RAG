export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function fail(error) {
  if (error instanceof HttpError) return json({ error: error.message, details: error.details }, error.status);
  console.error("unhandled", error);
  const message = error?.message || String(error);
  if (/not found|does not exist/i.test(message)) {
    return json({ error: `Cloudflare 侧资源未找到：${message}`, hint: "在页面点“初始化资源”（POST /api/admin/setup）自动创建 D1 与 Vectorize 索引" }, 500);
  }
  return json({ error: `服务内部错误：${message}` }, 500);
}

async function readBody(request, limitBytes) {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limitBytes) throw new HttpError(413, `请求体过大，最多 ${Math.round(limitBytes / 1024)} KB`);
  return buffer;
}

export async function readJson(request, limitBytes = 4 * 1024 * 1024) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("json")) {
    const buffer = await readBody(request, limitBytes);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new HttpError(400, "内容不是合法 UTF-8 文本，请另存为 UTF-8 后重试");
    }
    if (!text.trim()) throw new HttpError(400, "请求体为空");
    return JSON.parse(text);
  }
  const buffer = await readBody(request, limitBytes);
  try {
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw new HttpError(400, "JSON 解析失败，请检查请求体格式");
  }
}

export async function readIngest(request, env) {
  const maxChars = Number(env.MAX_DOC_CHARS) || 200_000;
  const type = request.headers.get("content-type") || "";

  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const title = String(form.get("title") || "").trim();
    if (!file || typeof file.text !== "function") throw new HttpError(400, "未收到文件字段 file");
    const name = file.name || "untitled";
    if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|gz|png|jpg|jpeg|gif)$/i.test(name)) {
      throw new HttpError(415, `${name} 是二进制格式，Worker 内无法可靠解析。请先转成 .txt 或 .md 再上传`);
    }
    const text = await file.text();
    return { title: title || name.replace(/\.[^.]+$/, ""), text, origin: "upload" };
  }

  const body = await readJson(request);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url && body.text === undefined && body.content === undefined) {
    // 网址抓取由 create() 发起，这样本模块不依赖抓取模块，避免循环导入
    return { title: String(body.title || "").trim(), url, text: "", origin: "url" };
  }
  const text = typeof body.text === "string" ? body.text : typeof body.content === "string" ? body.content : "";
  if (body.text === undefined && body.content === undefined) {
    throw new HttpError(400, "缺少字段：请提供 text（正文内容）或 url（要抓取的网页地址）");
  }
  return { title: String(body.title || "未命名文档").trim() || "未命名文档", url: "", text, origin: "paste" };
}

export function validateTextField(text, maxChars) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "正文内容为空");
  if (text.length > maxChars) {
    throw new HttpError(413, `文档过长：${text.length} 字符，当前上限 ${maxChars} 字符。可在 wrangler.jsonc 的 vars.MAX_DOC_CHARS 调大，或拆成多篇上传`);
  }
}

export async function requireAuth(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) {
    throw new HttpError(403, "服务尚未配置访问令牌", {
      hint: [
        "这个 Worker 持有可创建/删除资源的 Cloudflare API Token，因此强制要求令牌后才开放接口",
        "在 Workers 控制台 Settings → Variables and Secrets 添加 Secret：ADMIN_TOKEN（自定义一个长随机串），重新部署或等待生效后再刷新页面",
      ],
    });
  }
  const header = request.headers.get("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (!(await safeEqual(String(token), String(provided)))) {
    throw new HttpError(401, "需要有效的访问令牌：在页面右上角填入 Token，或请求头带上 Authorization: Bearer <ADMIN_TOKEN>");
  }
}

async function safeEqual(a, b) {
  const bytes = (s) => new TextEncoder().encode(s);
  const [x, y] = [bytes(a), bytes(b)];
  if (x.length !== y.length) return false;
  if (typeof crypto.timingSafeEqual === "function") return crypto.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
