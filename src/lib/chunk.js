const SENTENCE_SPLIT = /(?<=[。！？；!?;])\s*/;

export function normalizeText(raw) {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 标题识别：markdown、中文公文/法规序号、十进制编号、全大写英文标题
const HEADING_PATTERNS = [
  { re: /^(#{1,6})\s+(.+)$/, level: (m) => m[1].length },
  { re: /^第\s*([一二三四五六七八九十百千零〇\d]+)\s*[章篇部]\s*(.{0,40})$/, level: () => 1 },
  { re: /^第\s*([一二三四五六七八九十百千零〇\d]+)\s*[节条]\s*(.{0,40})$/, level: () => 2 },
  { re: /^([一二三四五六七八九十百]+)[、.．]\s*(.{0,40})$/, level: () => 2 },
  { re: /^[（(]([一二三四五六七八九十\d]+)[)）]\s*(.{0,40})$/, level: () => 3 },
  { re: /^(\d+(?:\.\d+){0,3})[.、\s]\s*(.{0,60})$/, level: (m) => 1 + (m[1].match(/\./g) || []).length },
  { re: /^([A-Z][A-Z0-9 &'()/,\-]{2,40})$/, level: () => 2 },
];

export function detectHeading(line) {
  const text = String(line ?? "").trim();
  if (!text || text.length > 80) return null;
  if (/[。！？!?;；]$/.test(text) && !/^#{1,6}\s/.test(text)) return null;
  for (const { re, level } of HEADING_PATTERNS) {
    const match = text.match(re);
    if (match) return { level: Number(level(match)) || 1, title: text.replace(/^#+\s*/, "").slice(0, 60) };
  }
  return null;
}

function hardCut(unit, maxChars) {
  const out = [];
  for (let i = 0; i < unit.length; i += maxChars) out.push(unit.slice(i, i + maxChars));
  return out;
}

// 段落 → 句子 → 硬切，每个单元都带上它所属的标题路径
function toUnits(text, maxChars) {
  const units = [];
  const stack = [];
  const pathOf = () => stack.map((heading) => heading.title).join(" › ");

  for (const block of text.split(/\n{2,}/)) {
    const paragraph = block.trim();
    if (!paragraph) continue;

    let body = paragraph;
    const lines = paragraph.split("\n");
    const heading = detectHeading(lines[0]);
    if (heading) {
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push(heading);
      body = lines.slice(1).join("\n").trim();
      if (!body) continue;
    }

    if (body.length <= maxChars) {
      units.push({ text: body, path: pathOf() });
      continue;
    }
    for (const sentence of body.split(SENTENCE_SPLIT)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= maxChars) units.push({ text: s, path: pathOf() });
      else for (const piece of hardCut(s, maxChars)) units.push({ text: piece, path: pathOf() });
    }
  }
  return units;
}

// 相邻切片保留尾部重叠避免断句丢召回；跨章节不重叠，改为注入新章节路径
function packUnits(units, maxChars, overlap) {
  const chunks = [];
  let current = null;
  for (const unit of units) {
    const prefix = unit.path ? `【${unit.path}】\n` : "";
    if (!current || unit.path !== current.path || current.text.length + unit.text.length + 1 > maxChars) {
      if (current) chunks.push(current.text);
      const tail =
        current && unit.path === current.path && overlap > 0 ? current.text.slice(-overlap) : "";
      const head = tail ? `${tail}\n${prefix}${unit.text}` : `${prefix}${unit.text}`;
      current = { path: unit.path, text: tail && head.length <= maxChars ? head : `${prefix}${unit.text}` };
    } else {
      current.text += `\n${unit.text}`;
    }
  }
  if (current) chunks.push(current.text);
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

export function chunkText(raw, options = {}) {
  const maxChars = Math.max(120, Number(options.maxChars) || 600);
  const overlap = Math.max(0, Number(options.overlap) || 0);
  const text = normalizeText(raw);
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const units = toUnits(text, maxChars);
  return packUnits(units, maxChars, Math.min(overlap, Math.floor(maxChars / 2)));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

export function extractText(filename, content) {
  const ext = String(filename || "").split(".").pop()?.toLowerCase();
  return ext === "html" || ext === "htm" ? normalizeText(stripHtml(content)) : normalizeText(content);
}
