#!/usr/bin/env node
/**
 * 给 better-sqlite3 拉一份 Electron ABI 的预编译二进制，放到 apps/desktop/native/。
 *
 * 为什么要单独一份：原生模块按 ABI 编译，Node 和 Electron 的 NODE_MODULE_VERSION
 * 不同。就地重编译会让 CLI 和测试当场全挂（实测：NODE_MODULE_VERSION 127 vs 130）。
 * 所以仓库里保留 Node 那份，Electron 那份放在这里，由主进程通过
 * ASSIT_SQLITE_NATIVE_BINDING 指过去。
 *
 * 不进 git：它是 arm64/x64 平台相关的，而且绑定具体的 Electron 版本。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/desktop/package.json'));

const electronVersion = require('electron/package.json').version;
const bsDir = path.dirname(require.resolve('better-sqlite3/package.json'));
const built = path.join(bsDir, 'build/Release/better_sqlite3.node');
const target = path.join(root, 'apps/desktop/native/better_sqlite3.node');

console.log(`electron ${electronVersion}`);
console.log(`better-sqlite3 ${bsDir}`);

const backup = fs.existsSync(built) ? fs.readFileSync(built) : null;
try {
  execFileSync(
    'npx',
    ['--yes', 'prebuild-install@7', '-r', 'electron', '-t', electronVersion, '--tag-prefix', 'v'],
    { cwd: bsDir, stdio: 'inherit' },
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(built, target);
  console.log(`→ ${path.relative(root, target)}`);
} finally {
  // 原地那份必须恢复成 Node ABI，否则 CLI 和测试全挂
  if (backup) {
    fs.writeFileSync(built, backup);
    console.log('已恢复 Node ABI 的那份（CLI / 测试用）');
  } else {
    execFileSync('npx', ['--yes', 'prebuild-install@7', '--tag-prefix', 'v'], {
      cwd: bsDir,
      stdio: 'inherit',
    });
  }
}
