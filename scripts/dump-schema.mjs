// 从唯一来源 src/lib/schema.js 导出 schema.sql，供 CLI 迁移使用（npm run schema:dump）
import { writeFileSync } from "node:fs";
import { SCHEMA_SQL } from "../src/lib/schema.js";

const target = new URL("../schema.sql", import.meta.url);
writeFileSync(target, SCHEMA_SQL);
console.log(`✓ 已生成 schema.sql（${SCHEMA_SQL.split("\n").length} 行）`);
