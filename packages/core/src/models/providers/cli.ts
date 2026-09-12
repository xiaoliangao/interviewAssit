import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider, ProviderSpec } from '../types.js';

const exec = promisify(execFile);

/**
 * 本机已登录的 CLI（claude / codex / gemini …）。
 *
 * 注意它的 max_visibility 与 api:* 相同，都是 public：这些 CLI 照样把内容
 * 发到各自云端，隐私边界跟直接调 API 没有区别。把它当「本地」是错的。
 *
 * 代价：输出格式没有兼容性承诺，版本一变就可能解析失败 —— 所以要记录
 * detected_version，版本变了重跑冒烟测试。
 */
export function cliProvider(spec: ProviderSpec & { bin: string; args?: string[] }): Provider {
  return {
    spec,
    async isAvailable() {
      try {
        await exec(spec.bin, ['--version'], { timeout: 4000 });
        return true;
      } catch {
        return false;
      }
    },
    async complete(req) {
      const prompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
      const args = spec.args ?? ['-p'];
      const { stdout } = await exec(spec.bin, [...args, prompt], {
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { text: stdout.trim() };
    },
  };
}

export async function detectVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ['--version'], { timeout: 4000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}
