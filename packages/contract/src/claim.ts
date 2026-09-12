import { z } from 'zod';
import { IsoDate, Visibility } from './common.js';

/** 责任等级。简历改写只能动措辞，不能动这个字段（DESIGN §13.7）。 */
export const ResponsibilityLevel = z.enum([
  '参与',
  '负责模块',
  '主导方案或交付',
  '项目负责人',
]);
export type ResponsibilityLevel = z.infer<typeof ResponsibilityLevel>;

/** 「已过期」这一档来自 ASu-skills：会随时间漂移的事实需重新确认才能用。 */
export const VerificationStatus = z.enum(['已确认', '待确认', '已过期', '不采用']);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const CodeEvidence = z.object({
  repo: z.string().min(1),
  prs: z.array(z.string()).default([]),
  commits: z.array(z.string()).default([]),
  files_touched: z.array(z.string()).default([]),
  /** 关联到项目图谱的模块路径（M0b 求交产物） */
  modules: z.array(z.string()).default([]),
  loc: z
    .object({
      added: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
    })
    .optional(),
  /** 本人 commit 行数占该 PR 比例。只用于排序候选，绝不用于自动判定 responsibility_level。 */
  author_share_in_pr: z.number().min(0).max(1).optional(),
  is_core_path: z.boolean().optional(),
  visibility: Visibility,
});
export type CodeEvidence = z.infer<typeof CodeEvidence>;

/** 非程序员降级路径（DESIGN §5.7）：账本结构不变，只换证据类型。 */
export const ArtifactEvidence = z.object({
  kind: z.enum(['document', 'portfolio', 'certificate', 'reference', 'link', 'other']),
  label: z.string().min(1),
  location: z.string().optional(),
  visibility: Visibility,
});
export type ArtifactEvidence = z.infer<typeof ArtifactEvidence>;

export const Metric = z.object({
  name: z.string().min(1),
  before: z.union([z.string(), z.number(), z.null()]),
  after: z.union([z.string(), z.number(), z.null()]),
  unit: z.string().optional(),
  /** 待补的数字永远由人填，渲染层输出占位符，模型绝不代填（DESIGN §13.7）。 */
  status: z.enum(['已确认', '待补']),
});
export type Metric = z.infer<typeof Metric>;

export const InterviewDetails = z
  .object({
    decision: z.string().optional(),
    difficulty: z.string().optional(),
    verification: z.string().optional(),
    result: z.string().optional(),
  })
  .partial();

export const Claim = z
  .object({
    id: z.string().regex(/^claim-[a-z0-9][a-z0-9-]*$/, 'id 形如 claim-proj-003'),
    source_fact: z.string().min(1, '原始事实不能为空'),
    candidate_wording: z.string().optional(),
    candidate_wording_en: z.string().optional(),
    responsibility_level: ResponsibilityLevel,
    verification_status: VerificationStatus,
    /** 团队成果与个人贡献的分界。即使「已确认」也必须保留 —— 这是项目深挖的基础。 */
    boundary: z.string().min(1, 'boundary 必填：写清团队做了什么、你做了什么'),
    visibility: Visibility.default('private'),
    code_evidence: CodeEvidence.optional(),
    artifact_evidence: z.array(ArtifactEvidence).default([]),
    interview_details: InterviewDetails.default({}),
    metrics: z.array(Metric).default([]),
    /** 可用于哪些简历版本；空数组表示不限 */
    allowed_uses: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    risk_notes: z.string().optional(),
    /** 最近确认日期。null 表示从未确认。 */
    last_verified: IsoDate.nullable().default(null),
  })
  .strict();
export type Claim = z.infer<typeof Claim>;

/** 可进入最终 PDF 的状态。其余只能进审计稿。 */
export const RENDERABLE_STATUS: VerificationStatus[] = ['已确认'];

/**
 * 责任等级的措辞上限。改写产物若越级使用这些词，渲染层拒绝输出。
 * 「你在简历里写的，必须是你在面试里扛得住的。」
 */
export const LEVEL_FORBIDDEN_TERMS: Record<ResponsibilityLevel, string[]> = {
  参与: [
    '主导', '负责', '牵头', '带领', '独立完成', '从 0 到 1', '从0到1',
    'owned', 'own ', 'led ', 'leading', 'spearhead', 'drove', 'architected', 'single-handedly',
  ],
  负责模块: [
    '主导整体', '牵头全项目', '架构设计负责人',
    'owned the entire', 'led the whole', 'architected the system',
  ],
  主导方案或交付: ['项目负责人', '团队负责人', 'managed the team', 'people manager'],
  项目负责人: [],
};
