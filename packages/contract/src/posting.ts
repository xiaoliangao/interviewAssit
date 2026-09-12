import { z } from 'zod';
import { tristate } from './common.js';

/**
 * 采集器的统一输出契约（DESIGN §4.1）。
 * 每个平台一个采集模块，输出必须过这个 schema —— 契约测试锁住它，
 * 平台页面改版时是显式失败，而不是悄悄产出半截数据污染岗位池。
 */
export const JobAttrs = z
  .object({
    education: tristate(z.string()),
    exp_years_min: tristate(z.number()),
    work_schedule: tristate(z.string()),
    remote: tristate(z.string()),
    tech_stack: tristate(z.array(z.string())),
    headcount: tristate(z.number()),
  })
  .partial();
export type JobAttrs = z.infer<typeof JobAttrs>;

export const Posting = z
  .object({
    platform: z.string().min(1),
    platform_job_id: z.string().min(1),
    url: z.string().optional(),
    company_name: z.string().min(1),
    title: z.string().min(1),
    city: z.string().nullable().default(null),
    /** 原始薪资串永远保留 —— 结构化解析可能出错，原文是唯一可回溯的东西 */
    salary_raw: z.string().nullable().default(null),
    salary_min_yuan: z.number().int().nullable().default(null),
    salary_max_yuan: z.number().int().nullable().default(null),
    salary_months: z.number().int().nullable().default(null),
    jd_text: z.string().min(1),
    apply_channel: z.enum(['chat', 'form', 'email', 'external', 'unknown']).default('unknown'),
    attrs: JobAttrs.default({}),
    collected_by: z.string().min(1),
    collected_at: z.string().min(1),
  })
  .strict();
export type Posting = z.infer<typeof Posting>;
