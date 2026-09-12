import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Claim, Profile, REQUIRED_PROFILE_FIELDS, ReposFile, Rubric } from '@assit/contract';
import type { ZodError } from 'zod';
import { loadRawClaims, loadRawProfile, loadRawRepos, type FactBase } from './load.js';
import { paths } from '../util/paths.js';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  file: string;
  where?: string;
  message: string;
  hint?: string;
}

export interface ValidateResult {
  ok: boolean;
  findings: Finding[];
  facts?: FactBase;
}

function zodFindings(file: string, err: ZodError): Finding[] {
  return err.issues.map((i) => ({
    severity: 'error' as const,
    file,
    where: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

/**
 * `assit init` 生成的模板值。
 *
 * 没有这条检查的话，未编辑的模板会校验「通过」，然后你在凌晨一点生成一份
 * 写着「张三 / 13800000000」的简历投出去。这种事真的会发生。
 */
const TEMPLATE_VALUES: Record<string, string[]> = {
  'name.zh': ['张三'],
  'name.en': ['San Zhang'],
  phone: ['13800000000'],
  email: ['you@example.com'],
  github: ['https://github.com/yourname'],
};
const TEMPLATE_CLAIM_IDS = ['claim-example-001'];
const TEMPLATE_COMPANIES = ['杭州某某科技有限公司', '某某大学'];

/**
 * rubric 里的模板值。
 *
 * 和 profile 的模板检测是同一个道理，但后果不同：profile 的模板值会印在简历上，
 * rubric 的模板值会**悄悄地把分数算成别人的**。一份按「5 年 Go / 月薪 45k / 杭州上海」
 * 算出来的 82 分，对一个 2 年前端来说毫无意义 —— 而界面上它看起来和真分数一模一样。
 */
const TEMPLATE_RUBRIC: { path: string; value: unknown; hint: string }[] = [
  { path: 'profile.stack', value: ['go', 'redis', 'mysql', 'kubernetes', 'kafka', 'docker', 'linux'],
    hint: '写你真能扛住追问的技术栈，不是你听说过的' },
  { path: 'profile.cities', value: ['杭州', '上海'], hint: '换成你真正会去的城市' },
  { path: 'profile.target_roles', value: ['backend', 'sre', 'architect', 'swe', 'fullstack'],
    hint: '换成你要投的职能族。这道闸挡的是「销售岗拿 80 分」那类假阳性' },
];

function monthsSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso.length === 7 ? `${iso}-01` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
}

export interface ValidateOptions {
  /** 超过这个月数未 last_verified 的「已确认」主张，提示应转「已过期」 */
  staleMonths?: number;
  now?: Date;
}

/**
 * 事实库校验。移植 ASu-skills 的 validate_claim_ledger.py 的逻辑，
 * 加上本项目的扩展（code_evidence / visibility / 证书 expires_at）。
 *
 * 分级的用意：error 拦住流程，warn 是「你该处理但不拦你投简历」。
 * 全做成 error 的结果是你会加 --force，然后 --force 变成默认习惯。
 */
export function validateFacts(opts: ValidateOptions = {}): ValidateResult {
  const now = opts.now ?? new Date();
  const staleMonths = opts.staleMonths ?? 12;
  const findings: Finding[] = [];

  // ---------- profile ----------
  const rawProfile = loadRawProfile();
  let profile: Profile | undefined;
  if (!rawProfile) {
    findings.push({
      severity: 'error',
      file: 'facts/profile.yaml',
      message: '档案文件不存在',
      hint: '运行 `assit init` 生成模板',
    });
  } else {
    const r = Profile.safeParse(rawProfile.raw);
    if (!r.success) findings.push(...zodFindings(rawProfile.relative, r.error));
    else {
      profile = r.data;
      for (const k of REQUIRED_PROFILE_FIELDS) {
        if (!profile.fields[k]?.trim()) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `fields.${k}`,
            message: `必填登记字段缺失：${k}`,
          });
        }
      }
      for (const [key, values] of Object.entries(TEMPLATE_VALUES)) {
        const v = profile.fields[key];
        if (v && values.includes(v)) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `fields.${key}`,
            message: `${key} 还是 \`assit init\` 的模板值：${v}`,
            hint: '换成你自己的。这个值会被原样印在简历和网申表单上',
          });
        }
      }
      for (const [i, e] of profile.records.employment.entries()) {
        if (TEMPLATE_COMPANIES.includes(e.company)) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `records.employment[${i}].company`,
            message: `公司名还是模板值：${e.company}`,
          });
        }
      }
      for (const [i, e] of profile.records.education.entries()) {
        if (TEMPLATE_COMPANIES.includes(e.school)) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `records.education[${i}].school`,
            message: `学校名还是模板值：${e.school}`,
          });
        }
      }

      // 证书有效期：过期的不允许进简历与表单，所以这里必须先喊出来
      for (const [i, c] of profile.records.certificate.entries()) {
        if (c.expires_at && monthsSince(c.expires_at, now)! > 0) {
          findings.push({
            severity: 'warn',
            file: rawProfile.relative,
            where: `records.certificate[${i}]`,
            message: `证书已过期（${c.expires_at}）：${c.name}`,
            hint: '渲染层会拒绝输出它。续期后更新 expires_at，或删掉这条',
          });
        }
      }
      for (const [i, e] of profile.records.employment.entries()) {
        if (e.end_at && e.start_at > e.end_at) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `records.employment[${i}]`,
            message: `起止时间颠倒：${e.start_at} → ${e.end_at}`,
          });
        }
        if (e.is_current && e.end_at) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `records.employment[${i}]`,
            message: 'is_current=true 但填了 end_at',
          });
        }
      }
      for (const [i, e] of profile.records.education.entries()) {
        if (e.end_at && e.start_at > e.end_at) {
          findings.push({
            severity: 'error',
            file: rawProfile.relative,
            where: `records.education[${i}]`,
            message: `起止时间颠倒：${e.start_at} → ${e.end_at}`,
          });
        }
      }
    }
  }

  // ---------- claims ----------
  const claims: Claim[] = [];
  const claimSource = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const rf of loadRawClaims()) {
    const r = Claim.safeParse(rf.raw);
    if (!r.success) {
      findings.push(...zodFindings(rf.relative, r.error));
      continue;
    }
    const c = r.data;
    const prev = seen.get(c.id);
    if (prev) {
      findings.push({
        severity: 'error',
        file: rf.relative,
        where: 'id',
        message: `主张 id 重复：${c.id}（另见 ${prev}）`,
      });
      continue;
    }
    seen.set(c.id, rf.relative);
    claimSource.set(c.id, rf.path);
    claims.push(c);

    if (TEMPLATE_CLAIM_IDS.includes(c.id)) {
      findings.push({
        severity: 'warn',
        file: rf.relative,
        where: 'id',
        message: '这还是 `assit init` 的示例主张',
        hint: '改成你自己的项目，或删掉它 —— 示例数据进简历比空简历更糟',
      });
    }

    // ---- 语义检查：这些是 schema 表达不了的，但恰恰是最容易出事的地方 ----

    if (c.verification_status === '已确认' && !c.last_verified) {
      findings.push({
        severity: 'error',
        file: rf.relative,
        where: 'last_verified',
        message: '标成「已确认」但没有确认日期',
        hint: '确认是一个有时间的动作。填上你最后一次核实它的日期',
      });
    }

    const age = monthsSince(c.last_verified, now);
    if (c.verification_status === '已确认' && age !== null && age > staleMonths) {
      findings.push({
        severity: 'warn',
        file: rf.relative,
        where: 'last_verified',
        message: `已确认但 ${Math.floor(age)} 个月未复核`,
        hint: '在读年级、论文状态、Star 数这类事实会漂移。复核或转「已过期」',
      });
    }

    if (c.boundary.trim().length < 8) {
      findings.push({
        severity: 'warn',
        file: rf.relative,
        where: 'boundary',
        message: 'boundary 太短，看不出团队与个人的分界',
        hint: '面试官追问「这块具体你做了什么」时，答案应该就在这一行里',
      });
    }

    const ce = c.code_evidence;
    if (ce) {
      if (ce.visibility !== c.visibility) {
        findings.push({
          severity: 'error',
          file: rf.relative,
          where: 'code_evidence.visibility',
          message: `代码证据的 visibility(${ce.visibility}) 与主张的 visibility(${c.visibility}) 不一致`,
          hint: '路由层按 visibility 拦截，两处不一致会让拦截失效',
        });
      }
      if (ce.commits.length === 0 && ce.prs.length === 0) {
        findings.push({
          severity: 'warn',
          file: rf.relative,
          where: 'code_evidence',
          message: '有 code_evidence 但既无 commit 也无 PR',
          hint: '项目深挖靠这些指针拉 diff 出题；空的话这条主张追问不了',
        });
      }
    }

    if (c.verification_status !== '不采用' && !c.candidate_wording) {
      findings.push({
        severity: 'info',
        file: rf.relative,
        where: 'candidate_wording',
        message: '没有候选表述，简历生成时会直接用 source_fact 兜底',
      });
    }

    for (const [i, m] of c.metrics.entries()) {
      if (m.status === '已确认' && m.after === null) {
        findings.push({
          severity: 'error',
          file: rf.relative,
          where: `metrics[${i}]`,
          message: `指标「${m.name}」标成已确认但没有 after 值`,
        });
      }
    }

    if (c.interview_details && Object.keys(c.interview_details).length === 0) {
      findings.push({
        severity: 'info',
        file: rf.relative,
        where: 'interview_details',
        message: '没有追问素材（决策 / 难点 / 验证 / 结果）',
        hint: '写简历时补一次，比面试前一晚现编靠谱',
      });
    }
  }

  if (claims.length === 0) {
    findings.push({
      severity: 'warn',
      file: 'facts/claims/',
      message: '没有任何主张，简历生成会是空的',
      hint: '先手写 2–3 条；M0b 之后可由项目解析自动提议',
    });
  }

  // ---------- repos ----------
  let repos: ReposFile = { repos: [] };
  const rawRepos = loadRawRepos();
  if (rawRepos) {
    const r = ReposFile.safeParse(rawRepos.raw);
    if (!r.success) findings.push(...zodFindings(rawRepos.relative, r.error));
    else {
      repos = r.data;
      for (const [i, rp] of repos.repos.entries()) {
        if (!fs.existsSync(rp.local_path)) {
          findings.push({
            severity: 'warn',
            file: rawRepos.relative,
            where: `repos[${i}].local_path`,
            message: `本地路径不存在：${rp.local_path}`,
          });
        }
      }
    }
  }

  // ---------- rubric ----------
  //
  // 以前这里什么都不查，后果是：rubric 文件和契约漂移之后，
  // **所有岗位静默地打不出分**，而 `assit validate` 说「通过」。
  // 唯一的线索是界面角落一个横幅 —— 一个你会看一眼然后忘掉的横幅。
  //
  // 但 rubric 坏掉**不该拦住简历生成**：打分和简历是两件独立的事，
  // 你没配打分规则照样该能从事实库产出一份简历。所以 `facts` 能不能用
  // 只看事实库自己，rubric 的问题进 findings、进退出码，不进这道闸。
  const factsOk = !findings.some((f) => f.severity === 'error');
  findings.push(...validateRubricFile());

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    findings,
    facts: factsOk && profile ? { profile, claims, claimSource, repos } : undefined,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 校验 rubric：能不能解析 + 是不是还留着模板值。
 *
 * 刻意不 import scoring/rubric.ts 的 loadRubric —— 那个函数解析失败就抛，
 * 而这里要的是**把问题变成一条 finding**，和档案的问题排在同一张清单上。
 * 一个人能记住的只有一张清单。
 */
export function validateRubricFile(): Finding[] {
  const dir = paths.rubricDir;
  const out: Finding[] = [];
  // 「还没配打分规则」是一个合法的早期状态（M0 就没有打分），所以是 warn。
  // 「配了但是坏的」才是 error —— 那会让所有岗位静默地没有分数。
  if (!fs.existsSync(dir)) {
    return [{ severity: 'warn', file: 'facts/rubric/', message: '还没有 rubric，岗位可以入库但没有分数', hint: '跑 `assit init --only rubric`' }];
  }
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) {
    return [{ severity: 'warn', file: 'facts/rubric/', message: '还没有 rubric，岗位可以入库但没有分数', hint: '跑 `assit init --only rubric`' }];
  }
  const name = files[files.length - 1]!;
  const rel = `facts/rubric/${name}`;
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  } catch (e) {
    return [{ severity: 'error', file: rel, message: `YAML 解析失败：${(e as Error).message}` }];
  }
  const r = Rubric.safeParse(raw);
  if (!r.success) {
    out.push(...zodFindings(rel, r.error));
    out.push({
      severity: 'error',
      file: rel,
      message: '这份 rubric 解析不了，所以所有岗位都打不出分',
      hint: '多半是早期版本的模板留在这里了。对照 `assit init` 生成的新模板改，或者备份后重新生成',
    });
    return out;
  }

  const rub = r.data as unknown as Record<string, any>;
  for (const t of TEMPLATE_RUBRIC) {
    const [a, b] = t.path.split('.');
    if (sameValue(rub[a!]?.[b!], t.value)) {
      out.push({
        severity: 'warn',
        file: rel,
        where: t.path,
        message: `${t.path} 还是 \`assit init\` 的模板值`,
        hint: t.hint,
      });
    }
  }
  if (Object.keys(r.data.weights).length === 0) {
    out.push({ severity: 'warn', file: rel, where: 'weights', message: 'weights 是空的，会退回默认权重' });
  }
  return out;
}

export function loadFactsOrThrow(opts?: ValidateOptions): FactBase {
  const r = validateFacts(opts);
  // 只看 facts：rubric 的问题不该拦住简历生成
  if (!r.facts) {
    const errs = r.findings.filter(
      (f) => f.severity === 'error' && !f.file.startsWith('facts/rubric'),
    );
    throw new Error(
      `事实库校验未通过（${errs.length} 个错误）。先跑 \`assit validate\` 修掉：\n` +
        errs.slice(0, 5).map((e) => `  ${e.file} ${e.where ?? ''}: ${e.message}`).join('\n'),
    );
  }
  return r.facts;
}

export function factsExist(): boolean {
  return fs.existsSync(paths.profile);
}

/**
 * 只读 repos.yaml，不要求档案完整。
 *
 * 扫仓库这件事在你填完档案之前就该能做 —— 事实上顺序常常是反的：
 * 先扫出候选主张，才想起来去补档案。
 */
export function loadReposOnly(): ReposFile {
  const raw = loadRawRepos();
  if (!raw) return { repos: [] };
  const r = ReposFile.safeParse(raw.raw);
  if (!r.success) {
    throw new Error(
      `facts/repos.yaml 格式有问题：\n` +
        r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  return r.data;
}
