import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Claim, Profile, ReposFile } from '@assit/contract';
import { paths } from '../util/paths.js';

/**
 * 事实库的真源是文件，不是数据库（plan §1.2）。
 *
 * 理由：一个人录入自己的档案，编辑器比表单快；文件可 diff、可 git 版本化、
 * 模型可以提议改动让你 review。SQLite 只是索引与关联层，随时可以从文件重建。
 */
export interface RawFile<T> {
  path: string;
  relative: string;
  raw: unknown;
  parsed?: T;
}

export function readYaml(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listClaimFiles(dir = paths.claimsDir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => path.join(dir, f))
    .sort();
}

export function loadRawProfile(file = paths.profile): RawFile<unknown> | null {
  if (!fs.existsSync(file)) return null;
  return { path: file, relative: path.relative(paths.data, file), raw: readYaml(file) };
}

export function loadRawClaims(dir = paths.claimsDir): RawFile<unknown>[] {
  return listClaimFiles(dir).map((f) => ({
    path: f,
    relative: path.relative(paths.data, f),
    raw: f.endsWith('.json') ? readJson(f) : readYaml(f),
  }));
}

export function loadRawRepos(file = paths.reposFile): RawFile<unknown> | null {
  if (!fs.existsSync(file)) return null;
  return { path: file, relative: path.relative(paths.data, file), raw: readYaml(file) };
}

/** 校验通过后的强类型视图。校验失败时不返回 —— 不允许半合法的事实库流到下游。 */
export interface FactBase {
  profile: Profile;
  claims: Claim[];
  claimSource: Map<string, string>;
  repos: ReposFile;
}
