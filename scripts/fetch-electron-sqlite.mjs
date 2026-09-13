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

/**
 * 备份之前先确认原地那份**真的是 Node ABI**。
 *
 * 踩过一次：electron-builder 的 @electron/rebuild 会就地把它换成 Electron ABI，
 * 这个脚本随后忠实地「恢复」了那个已经坏掉的版本 —— 于是 392 个测试全红，
 * 而脚本打印的是「已恢复」。一个会自信地恢复错东西的备份比没有备份更糟。
 */
function loadsInNode(file) {
  try {
    process.dlopen({ exports: {} }, file);
    return true;
  } catch {
    return false;
  }
}

const backup =
  fs.existsSync(built) && loadsInNode(built) ? fs.readFileSync(built) : null;
if (fs.existsSync(built) && !backup) {
  console.log('原地那份不是 Node ABI（多半被 electron-builder 换过），收尾时重新下载而不是恢复它');
}
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
  } else {
    execFileSync('npx', ['--yes', 'prebuild-install@7', '--tag-prefix', 'v'], {
      cwd: bsDir,
      stdio: 'inherit',
    });
  }
  // 恢复完再验一次。这一步是上面那个教训的另一半：
  // 「我以为恢复了」和「确实恢复了」必须能区分。
  if (loadsInNode(built)) {
    console.log('✓ Node ABI 已就位（CLI / 测试用）');
  } else {
    console.error('✗ 原地的 better-sqlite3 仍然不是 Node ABI —— CLI 和测试会全挂。');
    console.error(`  手动修：cd ${bsDir} && npx prebuild-install@7`);
    process.exitCode = 1;
  }
}
