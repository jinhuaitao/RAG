import { detectHeading, normalizeText } from "./chunk.js";

// 入库前的规则清洗：把网页/Word/PDF 复制粘贴带进来的噪声去掉，并把被硬断开的中文行
// 合并成完整段落，让切片按语义边界走，而不是按排版换行走。全部是本地字符串处理，
// 不调用模型，因此不会改写任何事实，也不会消耗 AI 额度。

const ZERO_WIDTH = /[\u200b-\u200d\u2028\u2029\u202a-\u202e\ufeff\u00ad]/g;
const WIDE_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const NOISE_PHRASES = [
  "返回目录", "返回顶部", "回到顶部", "展开更多", "展开", "收起", "查看更多", "点击查看", "点击此处",
  "上一篇", "下一篇", "上一页", "下一页", "相关推荐", "相关阅读", "热门推荐", "延伸阅读",
  "分享", "收藏", "点赞", "投币", "关注", "评论", "留言", "回复", "登录", "注册", "下载",
  "在线客服", "联系我们", "关于我们", "免责声明", "隐私政策", "使用条款", "保留所有权利", "版权所有",
  "标签[:：]?[^\\n]*", "本文?章?链接[:：]?[^\\n]*", "最后更新[:：]?[^\\n]*",
  "share(\\s+this)?", "save", "skip to (main\\s+)?content", "menu", "search", "close",
  "sign\\s+in", "log\\s*in", "sign\\s+up", "subscribe", "newsletter", "read\\s+more",
  "view\\s+more", "learn\\s+more", "copyright(\\s+©)?[^\\n]*", "all rights reserved",
  "terms of use", "privacy policy", "cookie\\s+(policy\\s*)?", "table of contents",
];
const NOISE_LINE = new RegExp(
  `^[\\s>*#\\-—•·\\[【]?\\s*(${NOISE_PHRASES.join("|")})\\s*[\\-—•·\\]]*[:：]?[\\s。.!！]*$`,
  "i"
);

// 只有短行才允许按“包含”删除，避免误伤正文里讨论版权/备案/扫码的句子
const STRONG_NOISE = /(版权所有|保留所有权利|all rights reserved|ICP备|备案号|返回顶部|回到顶部|扫码(关注|下载|查看|添加)|点击(此处|下方|这里)|本文档由.+生成|内容来自|未经(授权|许可)不得|whatsapp|telegram群)/i;
const PAGE_NUMBER = /^\s*(第?\s*\d+\s*页(\s*[/／]\s*共?\s*\d+\s*页)?|\d+\s*[/／]\s*\d+|[-–—]\s*\d+\s*[-–—]|page\s*\d+(\s+of\s+\d+)?|\d{1,4})\s*$/i;
const TOC_LEADER = /(\.{4,}|…{2,}|·{4,}|—{4,})\s*\d+\s*$/;
const DECORATIVE_ONLY = /^[\s\-—_=~*·•●○◆◇★☆※>＜〈〉「」『』【】()（）\[\]{}.,，。、;；:!?！？|\/\\+&%@#$^\u4000-\u4dff]*$/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*\|[\s|:-]*$/;
const LIST_OR_QUOTE = /^(\s*([-*+•]|\d+[.)、]|[（(][一二三四五六七八九十\d]+[)）])\s+|\s*>|\s*\|)/;

function isStructural(line) {
  return detectHeading(line) || LIST_OR_QUOTE.test(line) || line.startsWith("|");
}

const NOISE_TOKEN = new RegExp(`(${NOISE_PHRASES.join("|")})`, "gi");

// 整行只由噪声词组成（“分享  收藏  点赞”）；正文里出现这些词不受影响，
// 因为去掉噪声词后还剩内容就不算噪声行
function isNoiseLine(line) {
  if (NOISE_LINE.test(line)) return true;
  if (line.length > 60) return false;
  return !line.replace(NOISE_TOKEN, "").replace(/[\s|·•、,，。:：\-—/>》»]+/g, "");
}

// 面包屑导航：「官网 > 帮助中心 > 开票说明」
function isBreadcrumb(line) {
  if (line.length > 60 || /[。！？!?]$/.test(line)) return false;
  const separators = (line.match(/\s[>》»]\s/g) || []).length;
  return separators >= 2 || (separators === 1 && /^(首页|主页|home)/i.test(line.trim()));
}

function endsSentence(line) {
  return /[。！？!?;；:：…"'』」）)\]]$/.test(line);
}

function joinLine(prev, next) {
  if (/-{1,2}$/.test(prev) && /^[a-z]/i.test(prev.slice(-3)) && /^[a-z]/i.test(next)) {
    return `${prev.replace(/-{1,2}$/, "")}${next}`; // 英文跨行断词 exam-\nple
  }
  const cjk = /[\u3400-\u9fff]$/.test(prev) && /^[\u3400-\u9fff]/.test(next);
  return cjk ? `${prev}${next}` : `${prev} ${next}`;
}

function cleanLine(line) {
  return line
    .replace(ZERO_WIDTH, "")
    .replace(WIDE_SPACE, " ")
    .replace(CONTROL, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stripInlineMarkup(text) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:strong|b|em|i|u|span|a|font|small|sub|sup|mark)\b[^>]*>/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (match, label, href) => (/^https?:/.test(label) ? match : label))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

export function cleanText(raw) {
  const source = normalizeText(stripInlineMarkup(String(raw ?? "")));
  const before = source.length;
  if (!source) return { text: "", stats: { before: 0, after: 0, droppedLines: 0, mergedLines: 0 } };

  const total = source.split("\n").length;
  const counts = new Map();
  const kept = [];
  let dropped = 0;

  for (const rawLine of source.split("\n")) {
    const line = cleanLine(rawLine);
    if (!line) {
      kept.push("");
      continue;
    }
    const drop =
      DECORATIVE_ONLY.test(line) ||
      TABLE_SEPARATOR.test(line) ||
      PAGE_NUMBER.test(line) ||
      TOC_LEADER.test(line) ||
      isNoiseLine(line) ||
      isBreadcrumb(line) ||
      (line.length <= 40 && !/。/.test(line) && STRONG_NOISE.test(line));
    if (drop) {
      dropped += 1;
      kept.push("");
      continue;
    }
    // 跨页重复出现的短行基本是页眉页脚或水印
    const key = line.length >= 6 && line.length <= 60 && !/[。！？!?;；]$/.test(line) ? line : null;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    kept.push(line);
  }

  const repeated = new Set([...counts].filter(([, count]) => count >= 3).map(([line]) => line));
  const lines = [];
  for (const line of kept) {
    if (line && repeated.has(line)) {
      dropped += 1;
      lines.push("");
      continue;
    }
    lines.push(line);
  }

  // 合并被排版硬断开的行：空行仍是段落边界，标题、列表、表格行保持独立
  const blocks = [];
  let paragraph = [];
  let merged = 0;
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(paragraph.join(" "));
    paragraph = [];
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (isStructural(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    if (!paragraph.length) {
      paragraph.push(line);
      continue;
    }
    const prev = paragraph[paragraph.length - 1];
    if (endsSentence(prev)) {
      flush();
      paragraph.push(line);
      continue;
    }
    paragraph[paragraph.length - 1] = joinLine(prev, line);
    merged += 1;
  }
  flush();

  const text = normalizeText(blocks.join("\n\n"));
  return {
    text,
    stats: { before, after: text.length, droppedLines: dropped, mergedLines: merged, sourceLines: total },
  };
}
