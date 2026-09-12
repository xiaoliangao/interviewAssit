import { execFileSync } from 'node:child_process';

/**
 * 邮箱凭据只进系统钥匙串（DESIGN §13.5）。
 *
 * **不进 SQLite，不进配置文件，不进环境变量。**
 * 理由不是洁癖：`data/` 虽然 gitignore 了，但它会被备份、会被同步到云盘、
 * 会在你打包日志发给别人排查问题时一起出去。一个明文邮箱密码在那里面
 * 是迟早的事故。
 *
 * macOS 用 `security`，Linux 用 `secret-tool`（libsecret）。
 * 两个都没有就**拒绝保存**，不退化成明文文件。
 */

const SERVICE = 'assit-interview';

export type KeychainBackend = 'macos-security' | 'libsecret' | 'none';

export interface KeychainRunner {
  run: (bin: string, args: string[], input?: string) => string;
  has: (bin: string) => boolean;
}

const defaultRunner: KeychainRunner = {
  run: (bin, args, input) =>
    execFileSync(bin, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }),
  has: (bin) => {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
};

export function detectBackend(runner: KeychainRunner = defaultRunner): KeychainBackend {
  if (process.platform === 'darwin' && runner.has('security')) return 'macos-security';
  if (runner.has('secret-tool')) return 'libsecret';
  return 'none';
}

export class NoKeychain extends Error {
  constructor() {
    super(
      '找不到系统钥匙串（macOS 的 security / Linux 的 secret-tool）。\n' +
        '  **不会退化成明文文件。** data/ 虽然 gitignore 了，但它会被备份、\n' +
        '  被同步到云盘、在你打包日志发给别人排查时一起出去 ——\n' +
        '  一个明文邮箱密码在那里面是迟早的事故。\n' +
        '  Linux 装一下：apt install libsecret-tools',
    );
    this.name = 'NoKeychain';
  }
}

export function setPassword(account: string, password: string, runner: KeychainRunner = defaultRunner): void {
  const backend = detectBackend(runner);
  if (backend === 'none') throw new NoKeychain();
  if (backend === 'macos-security') {
    // -U 覆盖已有项；-w - 从 stdin 读密码，**不放进 argv**
    // （argv 在 ps 里对同机所有进程可见）
    runner.run('security', ['add-generic-password', '-a', account, '-s', SERVICE, '-U', '-w'], password);
  } else {
    runner.run('secret-tool', ['store', '--label', SERVICE, 'service', SERVICE, 'account', account], password);
  }
}

export function getPassword(account: string, runner: KeychainRunner = defaultRunner): string | null {
  const backend = detectBackend(runner);
  if (backend === 'none') return null;
  try {
    const out =
      backend === 'macos-security'
        ? runner.run('security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w'])
        : runner.run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    return out.replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

export function deletePassword(account: string, runner: KeychainRunner = defaultRunner): boolean {
  const backend = detectBackend(runner);
  if (backend === 'none') return false;
  try {
    if (backend === 'macos-security') {
      runner.run('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
    } else {
      runner.run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    }
    return true;
  } catch {
    return false;
  }
}
