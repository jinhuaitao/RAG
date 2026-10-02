import { HttpError } from "./http.js";

const MAX_REDIRECTS = 3;
const MIN_TEXT_CHARS = 40;

// 只允许公网 http/https，且拒绝会打到 Cloudflare/云厂商元数据接口的地址
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];

export function assertPublicUrl(rawUrl, env) {
  const allowPrivate = String(env.ALLOW_PRIVATE_URLS || "").toLowerCase() === "true";
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new HttpError(400, `网址格式不正确：${String(rawUrl).slice(0, 120)}`, { hint: "请填写完整网址，例如 https://example.com/docs/intro" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, `只支持 http/https 网址，当前是 ${url.protocol}`);
  }
  if (url.username || url.password) throw new HttpError(400, "网址里不要携带账号密码，请先在页面里登录后复制正文入库");

  // WHATWG URL 会把十进制/十六进制/短写形式的 IPv4 归一化成点分十进制，所以这里只需判断最终形态
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new HttpError(400, "网址缺少主机名");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new HttpError(400, `拒绝抓取内网地址 ${host}`, { hint: "出于安全考虑只能抓取公网网址" });
  }
  if (host === "metadata" || host.endsWith(".metadata")) throw new HttpError(400, "拒绝抓取云厂商元数据地址");

  // 元数据/保留段永远不放行；ALLOW_PRIVATE_URLS 只放开自建服务常用的私网段，供本机调试
  if (isMetadataAddress(host)) {
    throw new HttpError(400, `拒绝抓取元数据/保留地址 ${host}`, { hint: "这类地址会暴露实例凭据，无法通过任何开关放开" });
  }
  if (!allowPrivate && isPrivateAddress(host)) {
    throw new HttpError(400, `拒绝抓取内网地址 ${host}`, {
      hint: "只支持公网网址。若确实需要抓取本机或内网服务，把变量 ALLOW_PRIVATE_URLS 设为 true（不建议）",
    });
  }
  return url;
}

// 链路本地（含 169.254.169.254 元数据）、组播、未指定地址：任何情况下都不许抓取
function isMetadataAddress(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  if (host.includes(":")) {
    const clean = host.split("%")[0].toLowerCase();
    if (clean === "::") return true;
    const head = clean.replace(/^:+/, "").split(":")[0];
    if (/^fe8/.test(head) || /^ff/.test(head)) return true;
    const mapped = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(clean);
    if (mapped) {
      const [a, b] = mapped[1].split(".").map(Number);
      return a === 0 || (a === 169 && b === 254) || a >= 224;
    }
  }
  return false;
}

function isPrivateAddress(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host.split(".").map(Number));
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4([a, b]) {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 含 169.254.169.254 元数据地址
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 与 192.0.2.0/24
  if (a === 192 && b === 168) return true;
  if (a === 198 && b >= 18 && b <= 19) return true; // 基准测试 198.18.0.0/15
  if (a >= 224) return true; // 组播 224.0.0.0/4 与保留 240.0.0.0/4
  return false;
}

function isPrivateIpv6(address) {
  const clean = address.split("%")[0].toLowerCase();
  if (clean === "::" || clean === "::1") return true;
  const mapped = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(clean); // ::ffff:a.b.c.d 与 ::a.b.c.d
  if (mapped) return isPrivateIpv4(mapped[1].split(".").map(Number));
  const head = clean.replace(/^:+/, "").split(":")[0];
  if (/^(fe8|fe9|fea|feb)/.test(head)) return true; // 链路本地
  if (/^(fc|fd)/.test(head)) return true; // 唯一本地地址 fc00::/7
  if (/^ff/.test(head)) return true; // 组播
  const second = clean.split(":")[1];
  const secondValue = second === undefined || second === "" ? 0 : parseInt(second, 16);
  if (head === "2001" && secondValue === 0) return true; // Teredo 可封装内网 IPv4
  if (head === "2002") return true; // 6to4 内嵌任意 IPv4
  return false;
}

export async function grabUrl(env, rawUrl) {
  const timeoutMs = Math.min(30_000, Math.max(2_000, Number(env.FETCH_TIMEOUT_MS) || 8_000));
  const maxBytes = Math.min(6_000_000, Math.max(4_000, Number(env.FETCH_MAX_BYTES) || 800_000));

  let url = assertPublicUrl(rawUrl, env);
  let response;
  for (let hop = 0; ; hop += 1) {
    response = await request(url, timeoutMs);
    if (isRedirect(response.status)) {
      if (hop >= MAX_REDIRECTS) throw new HttpError(502, `抓取 ${url.href} 重定向超过 ${MAX_REDIRECTS} 次，已停止`);
      const location = response.headers.get("location");
      if (!location) throw new HttpError(502, `${url.href} 返回 ${response.status} 但没有 Location 头`);
      url = assertPublicUrl(new URL(location, url).href, env); // 每一跳都重新做内网校验
      continue;
    }
    break;
  }

  if (!response.ok) throw httpStatusError(url.href, response.status);

  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (/(pdf|msword|officedocument|spreadsheet|presentation|zip|octet-stream|image\/|video\/|audio\/)/.test(type)) {
    throw new HttpError(415, `该网址返回的是二进制内容（${type.split(";")[0]}），Worker 内无法解析。请另存为 .txt 或 .md 后上传`);
  }
  const isHtml = /text\/html|application\/xhtml/.test(type);
  const isPlainText = /text\/plain|text\/markdown|text\/xml/.test(type);
  if (!isHtml && !isPlainText && type) {
    throw new HttpError(415, `暂不支持该内容类型：${type.split(";")[0]}，只支持网页（HTML）与纯文本`);
  }

  const body = await readCapped(response, maxBytes, response.headers.get("content-type"));
  if (isPlainText) return { text: body, title: "", finalUrl: url.href, contentType: type };

  const title = extractTitle(body);
  const text = htmlToText(body);
  if (text.trim().length < MIN_TEXT_CHARS) {
    throw new HttpError(422, "这个网页里几乎没有可入库的正文", {
      hint: "常见原因：内容由 JavaScript 动态渲染、需要登录、或是反爬空页面。可在浏览器里打开页面，复制正文后用“粘贴正文”入库",
    });
  }
  return { text, title, finalUrl: url.href, contentType: type };
}

async function request(url, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url.href, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "rag-kb/1.0 (cloudflare workers url ingest)", accept: "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1" },
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (/timeout|abort/i.test(message)) {
      throw new HttpError(504, `抓取超时（${timeoutMs / 1000} 秒）：${url.href}`, { hint: "目标站点响应太慢，可把变量 FETCH_TIMEOUT_MS 调大" });
    }
    throw new HttpError(502, `无法连接 ${url.href}：${message}`, {
      hint: "可能是域名解析失败、目标站点屏蔽了 Cloudflare 出口、或只允许浏览器直接访问",
    });
  }
  return response;
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function httpStatusError(href, status) {
  if (status === 401 || status === 403) {
    return new HttpError(502, `抓取 ${href} 被拒绝（${status}）：该页面需要登录或开启了反爬`, {
      hint: "请在浏览器里打开并复制正文，再用“粘贴正文”入库",
    });
  }
  if (status === 404) return new HttpError(404, `抓取 ${href} 返回 404：页面不存在或已移动`);
  if (status === 429) return new HttpError(502, `抓取 ${href} 被限流（429），请稍后重试或改用粘贴正文`);
  return new HttpError(502, `抓取 ${href} 返回 ${status}`);
}

async function readCapped(response, maxBytes, contentType) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `网页过大：约 ${Math.round(declared / 1024)} KB，上限 ${Math.round(maxBytes / 1024)} KB。可把变量 FETCH_MAX_BYTES 调大`);
  }
  const decoder = pickDecoder(contentType);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value?.byteLength ?? 0;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, `网页过大：已超过 ${Math.round(maxBytes / 1024)} KB，抓取中断。可把变量 FETCH_MAX_BYTES 调大`);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function pickDecoder(contentType) {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(String(contentType || ""))?.[1]?.toLowerCase();
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // 未知编码退回 UTF-8，非法字节会被替换成 U+FFFD
    }
  }
  return new TextDecoder("utf-8");
}

const SKIP_TAGS = "script|style|noscript|svg|iframe|form|template|textarea|select|button|canvas|video|audio";
const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/",
  hellip: "…", mdash: "—", ndash: "–", middot: "·", middot_: "·",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷",
};

export function htmlToText(html) {
  const raw = String(html ?? "");
  const fromRegion = toText(pickRegion(raw));
  if (fromRegion.trim().length >= MIN_TEXT_CHARS) return fromRegion;
  return toText(raw) || fromRegion;
}

// 正文优先取最长的一段 <article>，其次 <main>，最后 <body>；都没有就用整份 HTML
function pickRegion(html) {
  const whole = new RegExp("<body\\b[^>]*>([\\s\\S]*?)<\\/body", "i").exec(html)?.[1] ?? html;
  for (const tag of ["article", "main"]) {
    const region = longestOpenRegion(html, tag);
    if (region.length > 200 && region.length >= whole.length * 0.3) return region;
  }
  return whole;
}

function longestOpenRegion(html, tag) {
  const opener = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const lower = html.toLowerCase();
  const closer = `</${tag}`;
  let best = "";
  let match;
  while ((match = opener.exec(html))) {
    const start = match.index + match[0].length;
    const end = lower.indexOf(closer, start);
    const content = html.slice(start, end === -1 ? html.length : end);
    if (content.length > best.length) best = content;
  }
  return best;
}

function toText(fragment) {
  let src = fragment.replace(/<!--[\s\S]*?-->/g, " ");
  src = src.replace(new RegExp(`<(${SKIP_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), " ");
  src = src.replace(new RegExp(`<(${SKIP_TAGS})\\b[\\s\\S]*$`, "gi"), " ");

  src = src
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<(li|dd|dt)\b[^>]*>/gi, "\n- ")
    .replace(/<\/(li|dd|dt)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|aside|nav|ul|ol|blockquote|pre|figure|figcaption|hgroup|center|tr|table)\s*>/gi, "\n\n")
    .replace(/<t[hd]\b[^>]*>/gi, " | ")
    .replace(/<hr\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");

  return normalize(decodeEntities(src));
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]{1,7}|\w{1,12});/g, (all, code) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? safeFromCodePoint(value) : all;
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? all : named;
  });
}

function safeFromCodePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2007\u202f\u3000]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html) {
  const meta = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["'][^>]*>/i.exec(html)?.[0];
  const content = meta && /content\s*=\s*["']([^"']+)["']/i.exec(meta)?.[1];
  if (content && content.trim()) return normalize(decodeEntities(content)).slice(0, 200);
  const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return tag ? normalize(decodeEntities(tag)).slice(0, 200) : "";
}
