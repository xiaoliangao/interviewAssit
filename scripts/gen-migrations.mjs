#!/usr/bin/env node
/**
 * 把 migrations/*.sql 内联进一个 TS 模块。
 *
 * 为什么不在运行时读目录：core 会被打包进 Electron 主进程，
 * 打包之后 import.meta.url 指向 bundle 内部，相对路径全部失效。
 *
 * 为什么仍然保留 .sql 文件：迁移的价值在于**可读、可 review、可 diff**。
 * 直接在 TS 里写字符串会让 schema 变更在 code review 里变成一坨转义。
 * 文件是真源，这个脚本只是把它搬运进构建产物。
 *
 * 防漂移：tests/migrations.test.ts 会重新生成一遍并和已提交的文件比对，
 * 改了 SQL 忘记重新生成会直接测试失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'packages/core/src/db/migrations');
const outFile = path.join(root, 'packages/core/src/db/migrations.generated.ts');

export function render() {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const entries = files.map((name) => {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    return `  {\n    name: ${JSON.stringify(name)},\n    sql: ${JSON.stringify(sql)},\n  },`;
  });
  return `// 由 scripts/gen-migrations.mjs 生成，不要手改。
// 真源是 packages/core/src/db/migrations/*.sql —— 改那边，然后跑 pnpm gen:migrations。

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
${entries.join('\n')}
];
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = render();
  fs.writeFileSync(outFile, text, 'utf8');
  console.log(`generated ${path.relative(root, outFile)} (${text.length} bytes)`);
}
