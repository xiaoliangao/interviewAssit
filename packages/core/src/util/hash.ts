import { createHash, randomBytes } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 内容派生的版本号。rubric / prompt 的版本不手写 —— 手写的版本号一定会忘记改，
 * 然后你就有两个不同规则产出的分数共用一个版本标签，永远对不上账。
 */
export function contentVersion(content: string): string {
  return sha256(content).slice(0, 8);
}

/** 单调递增、可排序的 id。不引 ulid 依赖。 */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(8).toString('hex');
  return `${prefix}${t}${r}`;
}
