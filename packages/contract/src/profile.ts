import { z } from 'zod';
import { IsoDate } from './common.js';

/**
 * 结构化档案 = 登记性事实（DESIGN §5.1 / §5.2）。
 *
 * 这里的任何值**永不经过改写模型**。自动填表照抄它，AI 改写只动 claims。
 * 这条边界在类型层就分开，不靠提示词约束。
 */

export const EducationRecord = z.object({
  school: z.string().min(1),
  degree: z.enum(['大专', '本科', '硕士', '博士', '其他']),
  major: z.string().min(1),
  start_at: IsoDate,
  end_at: IsoDate.nullable().default(null),
  /** 统招与否在国内表单里是独立字段，必须如实填 */
  is_statutory: z.boolean().optional(),
  gpa: z.string().optional(),
});

export const EmploymentRecord = z.object({
  /** 公司全称，不是简称 —— 表单和背调用的是全称 */
  company: z.string().min(1),
  department: z.string().optional(),
  title: z.string().min(1),
  city: z.string().optional(),
  start_at: IsoDate,
  end_at: IsoDate.nullable().default(null),
  is_current: z.boolean().default(false),
  leaving_reason: z.string().optional(),
});

export const CertificateRecord = z.object({
  name: z.string().min(1),
  issuer: z.string().optional(),
  credential_id: z.string().optional(),
  issued_at: IsoDate,
  /** 有效期。过期证书禁止进入简历与表单（DESIGN §13.7） */
  expires_at: IsoDate.nullable().default(null),
});

export const LanguageRecord = z.object({
  language: z.string().min(1),
  exam: z.string().optional(),
  score: z.string().optional(),
  issued_at: IsoDate.optional(),
  expires_at: IsoDate.nullable().default(null),
});

export const AwardRecord = z.object({
  name: z.string().min(1),
  level: z.string().optional(),
  issuer: z.string().optional(),
  issued_at: IsoDate,
});

export const ProfileRecords = z
  .object({
    education: z.array(EducationRecord).default([]),
    employment: z.array(EmploymentRecord).default([]),
    certificate: z.array(CertificateRecord).default([]),
    language: z.array(LanguageRecord).default([]),
    award: z.array(AwardRecord).default([]),
  })
  .default({});

/**
 * 期望字段不属于档案 —— 它随岗位而变。
 * 这里只是默认值，每次投递可覆盖（applications.prefs_override）。
 */
export const PreferenceDefaults = z
  .object({
    expected_salary_min: z.number().int().positive().optional(),
    expected_salary_max: z.number().int().positive().optional(),
    expected_cities: z.array(z.string()).default([]),
    available_from: IsoDate.optional(),
    willing_relocate: z.boolean().optional(),
    willing_travel: z.boolean().optional(),
  })
  .default({});

export const Profile = z
  .object({
    /** 标量登记字段：name.zh / phone / email / city / github … */
    fields: z.record(z.string(), z.string()).default({}),
    records: ProfileRecords,
    preferences: PreferenceDefaults,
  })
  .strict();
export type Profile = z.infer<typeof Profile>;

export const REQUIRED_PROFILE_FIELDS = ['name.zh', 'phone', 'email'] as const;

/** 自动填表的字段三分类（DESIGN §7.2）。M2 用，M0 先把类型定死。 */
export const FieldClass = z.enum(['registry', 'narrative', 'decision']);
export type FieldClass = z.infer<typeof FieldClass>;

export const RepoEntry = z.object({
  full_name: z.string().min(1),
  local_path: z.string().min(1),
  /** 决定这个仓库的代码能不能发给云端模型。路由层按它强制拦截，不是标签。 */
  visibility: z.enum(['public', 'private', 'nda']),
  /**
   * 你在这个仓库里用过的 author 身份（邮箱或姓名）。
   * 人在不同公司、不同时期用不同的 git 邮箱是常态，只填一个会让归因少算一半。
   * 留空则回退到 profile.fields.email + git config user.email。
   */
  authors: z.array(z.string()).default([]),
  /** 只看这个日期之后的提交。老仓库全量扫既慢又会把早年的练手代码算进来。 */
  since: z.string().optional(),
  /** 额外排除的目录（除内置的 node_modules / vendor / dist 等之外） */
  exclude: z.array(z.string()).default([]),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

export const ReposFile = z.object({ repos: z.array(RepoEntry).default([]) }).strict();
export type ReposFile = z.infer<typeof ReposFile>;

/** 兼容旧名 */
export const REPOS_ENTRY = RepoEntry;
