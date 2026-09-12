import type { JobSource, Posting } from '@assit/contract';
import type { CapturedResponse } from './bridge/types.js';

/**
 * 通道 B · CDP 被动捕获（DESIGN §4.2 / §4.3）—— **接口先定下来，实现在 M2。**
 *
 * 这个文件现在不干活。它存在的理由是：内核和 matcher 的边界画在哪，
 * 决定了第二个平台是「再写一遍」还是「填一个表」。先把这条线画死，
 * 后面 BOSS / 51job / 猎聘 / 智联就都是同一个形状。
 *
 * 内核（写一份，平台无关）：
 *   接管已登录 Chrome → 导航真实搜索页 → 滚动加载 → 在 Network 域旁听响应
 *   → 节奏控制 → 风控判定 → 归一化 → 入库
 *
 * 每平台（一小块，就是下面这个 SiteMatcher）：
 *   旁听哪些 URL、搜索页怎么拼、响应 JSON 怎么翻成 Posting、风控码是哪些
 *
 * **零注入。** 工具不发任何请求，只读页面自己发出的那些。
 * 原因见 DESIGN §4.2：注入的 XHR 与页面自身请求特征不同，会被识别为异常环境。
 * 顺带解决了另外两件事 —— BOSS 的字体混淆是渲染层的，接口返回本来就是明文；
 * 51job 的 acw_sc__v2 / 瑞数动态参数 / HMAC 签名由页面 JS 自己算好，
 * 我们从头到尾不用面对它们。
 */

export type CdpSite = Extract<JobSource, { platform: 'cdp' }>['site'];

// CapturedResponse 定义在 bridge/types.ts —— 它描述的是「桥交回来的东西」，
// 属于桥那一侧的契约。这里只是转出去给 matcher 用。
export type { CapturedResponse };

export interface RiskVerdict {
  blocked: boolean;
  code?: number;
  reason?: string;
}

/**
 * 风控判定：**码表 + message 关键字兜底，两个都要。**
 *
 * 只认码表的话，平台加一个新码就会被当成「登录失败」，于是你去反复重登 ——
 * 那恰恰是被限流时最糟的反应。关键字兜底是为了在码表过期时仍然能停下来。
 */
export const RISK_MESSAGE_KEYWORDS = [
  '环境存在异常', '访问频繁', '操作太频繁', '安全校验', '滑块', '验证',
] as const;

export function riskFromMessage(message: string | undefined | null): RiskVerdict {
  if (!message) return { blocked: false };
  const hit = RISK_MESSAGE_KEYWORDS.find((k) => message.includes(k));
  return hit ? { blocked: true, reason: `响应 message 命中「${hit}」` } : { blocked: false };
}

export interface SiteMatcher {
  site: CdpSite;
  /** 人看的名字，用于日志和面板 */
  label: string;
  /** 搜索页 URL。内核导航到这里，然后滚动 —— 请求由页面自己发 */
  searchUrl(keyword: string, city?: string): string;
  /** 这个响应要不要收。只匹配岗位列表/详情接口，其余一概不碰 */
  matches(url: string): boolean;
  /**
   * 响应 → Posting。
   * **认不出来要抛异常，不许返回空数组。** 静默产出半截数据比显式失败难查得多。
   */
  parse(res: CapturedResponse): Posting[];
  /** 该平台已知的风控码 */
  riskCodes: readonly number[];
  /** 先看码表，没命中再看 message 关键字 */
  risk(res: CapturedResponse): RiskVerdict;
}

export class CdpNotImplemented extends Error {
  constructor(site: CdpSite) {
    super(
      `${site} 还没有 matcher。\n\n` +
        '现在就能用的替代：`assit ingest --from-clipboard`，复制 JD 粘进来，\n' +
        '去重、三态解析、打分、投递记录，下游处理和自动采集**完全一样**。',
    );
    this.name = 'CdpNotImplemented';
  }
}
