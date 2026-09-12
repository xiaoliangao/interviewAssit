import { z } from 'zod';

/**
 * 采集源配置（data/facts/sources.yaml）。
 *
 * 三类，风险递增，**配置形态刻意不统一** —— 不同风险等级长得一样是危险的：
 *
 * - `greenhouse` / `lever` / `ashby` / `jsonld`：标准 ATS，公开无登录，零风险
 * - `api`：大厂自建招聘站的公开接口，公开无登录，零风险（DESIGN §4.1 A2）
 * - `cdp`：要登录的平台（BOSS / 51job / 猎聘 / 智联），接管用户自己的浏览器
 *   被动旁听（DESIGN §4.2 / §4.3）。**有平台风险，所以默认 enabled: false。**
 *
 * `cdp` 通道实现之前，这些平台用 `assit ingest` 手动粘贴，下游处理完全一样。
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
    platform: z.literal('api'),
    id: z.string().min(1),
    /** 哪个自建站适配器。加一家 = 加一个 adapter，不在这里堆参数 */
    adapter: z.enum(['tencent', 'bytedance']),
    /** 搜索关键词，逐个跑。留空 = 不带关键词取该站默认排序 */
    keywords: z.array(z.string()).default([]),
    /** 城市名（适配器内部翻成各站自己的码）。留空 = 不限 */
    cities: z.array(z.string()).default([]),
    /** 每个关键词翻几页 */
    pages: z.number().int().min(1).max(50).default(3),
    /**
     * 用浏览器 UA 发请求。**默认关闭。**
     *
     * 字节的接口对非浏览器 UA 直接返回 405 —— 不开这个就采不到。
     * 但默认 UA 如实声明「我是个本地求职工具」是这个项目的一条原则
     * （见 collectors/_shared/http.ts 的 USER_AGENT）。
     *
     * 所以把这个选择放在**你自己的配置文件里**：它进 git、能被 review、
     * 三个月后你还能看到自己当初做过这个决定。采集器不替你悄悄改。
     */
    browser_ua: z.boolean().default(false),
    enabled: z.boolean().default(true),
    note: z.string().optional(),
  }),
  z.object({
    platform: z.literal('cdp'),
    id: z.string().min(1),
    site: z.enum(['boss', '51job', 'liepin', 'zhaopin']),
    keywords: z.array(z.string()).default([]),
    cities: z.array(z.string()).default([]),
    /** 连到已开着的 Chrome 的远程调试端口，复用你自己的登录态，不存任何凭据 */
    debug_port: z.number().int().min(1).max(65535).default(9222),
    /** 列表页之间的随机停顿（毫秒）。节奏是防线的一部分，但不能替代「遇风控即停」 */
    pace_ms: z.tuple([z.number().int(), z.number().int()]).default([5000, 10000]),
    /** **默认关闭**：这条通道有平台风险，开它是一次明确的决定 */
    enabled: z.boolean().default(false),
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
