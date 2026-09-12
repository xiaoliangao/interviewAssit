import { z } from 'zod';

/**
 * 采集源配置（data/facts/sources.yaml）。
 *
 * 全部是**公开发布**的招聘接口：无需登录、无需伪装、没有封号风险。
 * BOSS / 51job / 猎聘这类要登录的平台不在这里 —— 它们走浏览器扩展通道（M2），
 * 并且在那之前可以用 `assit ingest` 手动粘贴入库。
 */
export const JobSource = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('greenhouse'),
    id: z.string().min(1),
    /** boards-api.greenhouse.io/v1/boards/<board>/jobs */
    board: z.string().min(1),
    enabled: z.boolean().default(true),
    note: z.string().optional(),
  }),
  z.object({
    platform: z.literal('lever'),
    id: z.string().min(1),
    /** api.lever.co/v0/postings/<company> */
    company: z.string().min(1),
    enabled: z.boolean().default(true),
    note: z.string().optional(),
  }),
  z.object({
    platform: z.literal('ashby'),
    id: z.string().min(1),
    board: z.string().min(1),
    enabled: z.boolean().default(true),
    note: z.string().optional(),
  }),
  z.object({
    platform: z.literal('jsonld'),
    id: z.string().min(1),
    /** 任何输出 schema.org JobPosting 的页面：Moka、北森、大厂自建站都算 */
    urls: z.array(z.string().url()).min(1),
    /** 页面上没写公司名时的兜底 */
    company: z.string().optional(),
    enabled: z.boolean().default(true),
    note: z.string().optional(),
  }),
]);
export type JobSource = z.infer<typeof JobSource>;

export const SourcesFile = z.object({ sources: z.array(JobSource).default([]) }).strict();
export type SourcesFile = z.infer<typeof SourcesFile>;
