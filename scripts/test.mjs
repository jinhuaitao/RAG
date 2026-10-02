import assert from "node:assert/strict";
import { chunkText, extractText, normalizeText } from "../src/lib/chunk.js";
import { encodeVector } from "../src/lib/cfapi.js";

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

test("短文本只出一个片段", () => {
  const chunks = chunkText("Cloudflare Workers 是边缘运行时。", { maxChars: 600, overlap: 120 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Cloudflare Workers 是边缘运行时。");
});

test("中文长段落按句子边界聚合且不超过上限", () => {
  const sentence = "退货申请需要在签收后七天内提交，逾期不再受理。";
  const text = Array.from({ length: 40 }, (_, i) => `${sentence}第 ${i} 条补充说明。`).join("");
  const chunks = chunkText(text, { maxChars: 300, overlap: 60 });
  assert.ok(chunks.length > 3, `期望切成多段，实际 ${chunks.length}`);
  for (const c of chunks) assert.ok(c.length <= 300, `片段超长 ${c.length}`);
});

test("相邻片段带尾部重叠，避免边界丢句", () => {
  const text = Array.from({ length: 30 }, (_, i) => `句子${i}内容。`).join("");
  const chunks = chunkText(text, { maxChars: 120, overlap: 40 });
  assert.ok(chunks.length >= 2);
  const tail = chunks[0].slice(-10);
  assert.ok(chunks[1].includes(tail), "第二段应包含第一段的尾部内容");
});

test("空输入与纯空白不产生片段", () => {
  assert.deepEqual(chunkText("", { maxChars: 600 }), []);
  assert.deepEqual(chunkText("   \n\n  \t \n", { maxChars: 600 }), []);
});

test("归一化多余空行与 CRLF", () => {
  assert.equal(normalizeText("a\r\n\r\n\r\n\r\nb  \r\n"), "a\n\nb");
});

test("HTML 抽取正文并丢弃脚本样式", () => {
  const text = extractText("page.html", "<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>标题</h1><p>正文内容</p></body></html>");
  assert.ok(text.includes("正文内容"));
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("color:red"));
});

test("向量压到 6 位小数并保持维度", () => {
  const raw = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 3);
  const out = encodeVector(raw);
  assert.equal(out.length, 1024);
  assert.equal(out[1], Number((Math.sin(1) / 3).toFixed(6)));
  assert.ok(out.every((value) => typeof value === "number"));
});

test("TypedArray 与含 NaN 的向量按边界处理", () => {
  assert.deepEqual(encodeVector(new Float32Array([0.1, -0.25, 1 / 3])), [0.1, -0.25, 0.333333]);
  assert.throws(() => encodeVector([0.1, NaN]), /不是有限数字/);
  assert.throws(() => encodeVector([]), /空向量/);
});

test("1024 维 query 请求体体积可控且是合法 JSON", () => {
  const raw = Array.from({ length: 1024 }, (_, i) => (Math.sin(i * 12.9898) * 43758.5453) % 1);
  const full = JSON.stringify({ vector: raw, topK: 6, returnMetadata: false });
  const compact = JSON.stringify({ topK: 6, vector: encodeVector(raw) });
  assert.deepEqual(JSON.parse(compact).vector[0], encodeVector(raw)[0]);
  assert.ok(compact.length < full.length, "压缩后应更小");
  assert.ok(compact.length < 12_000, `请求体应远小于出问题时的 19478 字节，实际 ${compact.length}`);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
