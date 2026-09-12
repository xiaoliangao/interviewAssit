import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Rubric } from '@assit/contract';
import { contentVersion } from '../util/hash.js';
import { paths } from '../util/paths.js';

export interface LoadedRubric {
  rubric: Rubric;
  /** 文件内容的 hash 前 8 位。不手写版本号 —— 手写的一定会忘记改。 */
  version: string;
  file: string;
}

export function loadRubric(name?: string): LoadedRubric {
  const dir = paths.rubricDir;
  if (!fs.existsSync(dir)) {
    throw new Error(`没有 ${dir}。跑 \`assit init\` 生成模板，然后按你自己的偏好改。`);
  }
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const target = name
    ? files.find((f) => f === name || f.replace(/\.ya?ml$/, '') === name)
    : files[files.length - 1]; // 默认取字典序最后一个，通常是最新版本
  if (!target) {
    throw new Error(name ? `${dir} 里没有 ${name}` : `${dir} 里没有 rubric 文件`);
  }
  const file = path.join(dir, target);
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = Rubric.safeParse(YAML.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${target} 格式有问题：\n` +
        parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  return { rubric: parsed.data, version: contentVersion(raw), file };
}
