const SENTENCE_SPLIT = /(?<=[。！？；!?;])\s*/;

export function normalizeText(raw) {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hardCut(unit, maxChars) {
  const out = [];
  for (let i = 0; i < unit.length; i += maxChars) out.push(unit.slice(i, i + maxChars));
  return out;
}

function toUnits(text, maxChars) {
  const units = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= maxChars) {
      units.push(p);
      continue;
    }
    for (const sentence of p.split(SENTENCE_SPLIT)) {
      const s = sentence.trim();
      if (!s) continue;
      if (s.length <= maxChars) units.push(s);
      else units.push(...hardCut(s, maxChars));
    }
  }
  return units;
}

// 相邻切片保留 overlap 个字符的尾部重叠，避免句子在边界被切断导致召回丢失
function packUnits(units, maxChars, overlap) {
  const chunks = [];
  let current = "";
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    if (current.length + unit.length + 1 <= maxChars) {
      current += `\n${unit}`;
    } else {
      chunks.push(current);
      const tail = overlap > 0 ? current.slice(-overlap) : "";
      current = tail && tail.length + unit.length + 1 <= maxChars ? `${tail}\n${unit}` : unit;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

export function chunkText(raw, options = {}) {
  const maxChars = Math.max(120, Number(options.maxChars) || 600);
  const overlap = Math.max(0, Number(options.overlap) || 0);
  const text = normalizeText(raw);
  if (!text) return [];
  const units = toUnits(text, maxChars);
  if (text.length <= maxChars) return [text];
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
