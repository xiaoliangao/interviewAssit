import { z } from 'zod';

/**
 * 打分规则。它是 data/facts/rubric/*.yaml 里的一个文件，
 * `rubric_version` 由文件内容的 hash 派生 —— 不手写版本号，
 * 手写的一定会忘记改，然后你有两套规则产出的分数共用一个标签，永远对不上账。
 *
 * 条件是**封闭枚举**，不是可写表达式。写成表达式就要配一个求值器，
 * 那既是过度设计，也是一个把「配置文件」变成「可执行代码」的安全气味。
 */

export const CapCondition = z.enum([
  'core_stack_below_half', // 核心技术栈命中不足一半
  'core_stack_zero', // 一个都没命中
  'hard_gate_failed', // 有硬门槛未过
  'outsourcing_likely', // 外包概率超过阈值
  'schedule_bad', // 大小周 / 996
  'salary_below_floor', // 薪资低于你的下限
  'coverage_low', // 披露维度太少
]);
export type CapCondition = z.infer<typeof CapCondition>;

export const ScoreDimension = z.enum([
  'core_stack',
  'experience',
  'salary',
  'location',
  'schedule',
  'company',
]);
export type ScoreDimension = z.infer<typeof ScoreDimension>;

/** 你这一侧的参数。打分是「JD 对你」，不是「JD 好不好」。 */
export const RubricProfile = z
  .object({
    degree: z.enum(['大专', '本科', '硕士', '博士']).optional(),
    exp_years: z.number().min(0).optional(),
    cities: z.array(z.string()).default([]),
    accept_remote: z.boolean().default(true),
    /** 月薪下限：低于它就不考虑 */
    salary_floor_yuan: z.number().int().positive().optional(),
    /** 月薪目标：到这个数就给满分 */
    salary_target_yuan: z.number().int().positive().optional(),
    /** 你的技术栈。打分时和 JD 要求求交 */
    stack: z.array(z.string()).default([]),
    /** 能接受的作息，不在列表里的扣分 */
    acceptable_schedules: z.array(z.string()).default(['双休', '弹性']),
  })
  .strict();
export type RubricProfile = z.infer<typeof RubricProfile>;

export const Rubric = z
  .object({
    note: z.string().optional(),
    profile: RubricProfile,
    weights: z.record(ScoreDimension, z.number().min(0)).default({}),
    hard_gates: z
      .array(
        z.object({
          key: z.enum(['education', 'exp_years_min', 'salary_floor']),
          /** 容差：JD 要 5 年而你 4 年，slack=1 时仍算通过 */
          slack: z.number().min(0).default(0),
        }),
      )
      .default([]),
    caps: z
      .array(
        z.object({
          label: z.string().min(1),
          when: CapCondition,
          final_score_max: z.number().min(0).max(100),
          /** 部分条件需要阈值，如 outsourcing_likely 的 0.6 */
          threshold: z.number().optional(),
        }),
      )
      .default([]),
    /** 未知维度的处理。目前只允许一种 —— 记 0 分等于对信息披露少的岗位加负分。 */
    unknown_policy: z.literal('exclude_from_denominator').default('exclude_from_denominator'),
  })
  .strict();
export type Rubric = z.infer<typeof Rubric>;

export const DEFAULT_WEIGHTS: Record<ScoreDimension, number> = {
  core_stack: 40,
  experience: 15,
  salary: 15,
  location: 10,
  schedule: 10,
  company: 10,
};
