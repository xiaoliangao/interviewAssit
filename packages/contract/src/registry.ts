import { z } from 'zod';
import { IsoDate } from './common.js';

/**
 * 雇主注册表（`vendor/employer-registry/*.yaml`，进 git）。
 *
 * 回答一个问题：**「这家公司的岗位，我该走哪条路去拿？」**
 *
 * 它和 `sources.yaml` 的区别很重要：
 * - 注册表是**共享的、可版本化的事实**——哪家用哪个系统，token 是什么。几个月变一次。
 * - `sources.yaml` 是**你自己的订阅**——你想采哪几家、关键词是什么。随时改。
 *
 * 分开是因为风险等级不同。注册表里存的是采集器接下来要去请求的 URL，
 * 更新它是一个**供应链入口**：被污染的条目会让采集器去打攻击者的服务器，
 * 抓回来的东西还会以可信来源的身份进岗位池、进打分、进简历。
 * 所以 `assit registry sync` 必须是「拉取 → 显示 diff → 人工 apply」，
 * 上游钉 commit sha，绝不静默写入。
 */

export const EmployerStatus = z.enum([
  /** 采集路径已实测打通，能直接用 */
  'ok',
  /** 接口通，但要在 sources.yaml 里显式开 browser_ua（见 sources.ts） */
  'needs_browser_ua',
  /** 公开接口要凭据/签名 → 降级到通道 B。**不逆向** */
  'needs_cdp',
  /** 官网 URL 可达，但采集路径还没试过 —— 这是初版收录的默认状态 */
  'unverified',
  /** 以前能采，现在不行了。采集器坏掉是常态，这个状态是正常的 */
  'broken',
]);
export type EmployerStatus = z.infer<typeof EmployerStatus>;

export const EmployerEntry = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'id 只能是小写字母、数字、连字符'),
    name: z.string().min(1),
    /** 招聘主页。**这是人去看的入口**，不一定是接口地址 */
    homepage: z.string().url(),
    region: z.enum(['cn', 'global']).default('cn'),
    channel: z.enum(['ats', 'api', 'cdp', 'manual', 'unknown']).default('unknown'),
    /** channel=ats 时：跑在哪套招聘系统上，token 是什么 */
    ats: z
      .object({
        kind: z.enum(['greenhouse', 'lever', 'ashby', 'feishu', 'moka', 'beisen', 'dayee']),
        token: z.string().optional(),
      })
      .optional(),
    /** channel=api 时：用哪个自建站适配器 */
    adapter: z.enum(['tencent', 'bytedance']).optional(),
    status: EmployerStatus.default('unverified'),
    /**
     * 最后一次**真的打通**的日期。不是「最后一次编辑这行」的日期。
     *
     * 一个三个月没验证过的条目和一个已知坏掉的条目，在决策上是同一回事 ——
     * 所以这个字段由 `assit sources doctor` 回写，不手填。
     */
    verified_at: IsoDate.optional(),
    note: z.string().optional(),
  })
  .strict();
export type EmployerEntry = z.infer<typeof EmployerEntry>;

export const EmployerRegistryFile = z
  .object({
    /** 上游同步时钉住的 commit sha —— 跟 HEAD 就等于把供应链交给别人 */
    upstream: z.object({ repo: z.string(), commit: z.string() }).optional(),
    employers: z.array(EmployerEntry).default([]),
  })
  .strict();
export type EmployerRegistryFile = z.infer<typeof EmployerRegistryFile>;
