import { contentVersion } from '../util/hash.js';
import { validateFacts } from './validate.js';

/**
 * 当前事实库的版本标识。
 *
 * 它进 `job_scores` 的唯一键，因为「这个岗位对我合不合适」取决于**我是谁** ——
 * 事实库变了，旧分数就不可比了。用内容 hash 而不是手写版本号：
 * 手写的一定会忘记改，然后两批不同前提下算出来的分数共用一个标签。
 *
 * CLI 和桌面壳用的是同一个函数，否则两边会各自算出一个版本，
 * 然后同一个岗位在两个界面上显示不同的分数。
 */
export function currentProfileVersion(): string {
  const res = validateFacts();
  const ids = (res.facts?.claims ?? []).map((c) => c.id).sort().join(',');
  return `facts-${contentVersion(ids)}`;
}
