// 兜底脚本：查询远端 D1 的真实 UUID，写回 wrangler.jsonc 的占位符
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const dbName = process.argv[2];
if (!dbName) {
  console.error("用法: node scripts/set-config.mjs <database_name>");
  process.exit(1);
}

const raw = execFileSync("npx", ["wrangler", "d1", "info", dbName, "--json"], { encoding: "utf8" });
const jsonStart = raw.indexOf("{");
if (jsonStart < 0) throw new Error(`wrangler d1 info 没有输出 JSON：${raw}`);
const uuid = JSON.parse(raw.slice(jsonStart)).result?.uuid;
if (!uuid) throw new Error(`未能从 ${dbName} 读到 database_id`);

const path = "wrangler.jsonc";
const config = readFileSync(path, "utf8");
if (!config.includes("REPLACE_BY_PROVISION_SCRIPT")) {
  console.log(`wrangler.jsonc 的 database_id 已填充（${uuid} 未覆盖）`);
  process.exit(0);
}
writeFileSync(path, config.replace("REPLACE_BY_PROVISION_SCRIPT", uuid));
console.log(`✓ 已写入 database_id=${uuid}`);
