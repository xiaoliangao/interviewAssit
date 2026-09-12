/**
 * 邮件筛选与脱敏（DESIGN §7.3 / §13.6）。
 *
 * 一条原则贯穿全文：**先用确定性规则把无关邮件挡在外面，再让模型看剩下的。**
 *
 * 不是为了省 token。邮箱里有银行流水、医疗、家人的信 ——
 * 一个「把所有新邮件喂给模型分类」的实现，等于把整个邮箱交出去。
 * 白名单挡掉 95% 之后，模型只看到那 5% 看起来像求职相关的。
 */

export type MailCategory =
  | 'application_ack' // 投递回执
  | 'interview_invite'
  | 'rejection'
  | 'offer'
  | 'assessment' // 笔试/测评
  | 'recruiter_outreach'
  | 'unrelated';

export interface MailHeader {
  from: string;
  subject: string;
  date: string;
  messageId: string;
}

/** 招聘平台与常见 ATS 的发件域。命中就一定看。 */
export const PLATFORM_DOMAINS = [
  'zhipin.com', '51job.com', 'liepin.com', 'zhaopin.com', 'lagou.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'smartrecruiters.com',
  'mokahr.com', 'beisen.com', 'dayee.com', 'hire.lagou.com',
  'careers.tencent.com', 'jobs.bytedance.com', 'feishu.cn',
];

/** 主题里出现这些词，即使发件域不认识也看一眼。 */
const SUBJECT_HINTS =
  /(面试|笔试|测评|简历|应聘|录用|offer|入职|投递|招聘|人才|hr|interview|assessment|application|candidate|recruit)/i;

/**
 * 明确不看的。放在最前 —— 一封「您的账单」不该因为标题里有「确认」
 * 就进到模型面前。
 */
const HARD_EXCLUDE =
  /(账单|对账单|还款|支付成功|交易提醒|验证码|快递|物流|发票|水电费|体检|医院|挂号|保单|statement|invoice|receipt|otp|verification\s*code)/i;

export interface FilterResult {
  keep: boolean;
  reason: string;
  /** 命中的是平台域还是主题词。用来解释「凭什么看这封」 */
  matched: 'platform_domain' | 'subject_hint' | 'known_company' | null;
}

export interface FilterOptions {
  /** 你投过的公司域名。从 applications 推出来 —— 投过谁就看谁的信 */
  knownDomains?: string[];
}

export function shouldInspect(h: MailHeader, opts: FilterOptions = {}): FilterResult {
  const domain = (h.from.match(/@([^\s>]+)/)?.[1] ?? '').toLowerCase();
  const subject = h.subject ?? '';

  if (HARD_EXCLUDE.test(subject)) {
    return { keep: false, reason: '主题命中明确排除项（账单/验证码/物流这类）', matched: null };
  }
  if (PLATFORM_DOMAINS.some((d) => domain.endsWith(d))) {
    return { keep: true, reason: `发件域 ${domain} 是招聘平台`, matched: 'platform_domain' };
  }
  if (opts.knownDomains?.some((d) => domain.endsWith(d.toLowerCase()))) {
    return { keep: true, reason: `${domain} 是你投过的公司`, matched: 'known_company' };
  }
  if (SUBJECT_HINTS.test(subject)) {
    return { keep: true, reason: '主题里有求职相关词', matched: 'subject_hint' };
  }
  return { keep: false, reason: '既不是招聘平台，主题也看不出和求职有关', matched: null };
}

/**
 * 正文脱敏。
 *
 * 邮件正文经常带着**别人的**联系方式（HR 的手机、其他候选人被抄送）。
 * 那不是你的信息，不该出现在任何模型的上下文里。
 */
export function redactMailBody(body: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  let t = body;

  const rules: [RegExp, string, string][] = [
    [/\b1[3-9]\d{9}\b/g, '[手机号]', 'phone'],
    [/\b\d{3,4}-?\d{7,8}\b/g, '[座机]', 'landline'],
    [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[邮箱]', 'email'],
    [/\b\d{15}|\d{17}[\dXx]\b/g, '[身份证]', 'id_card'],
    [/\b\d{16,19}\b/g, '[银行卡]', 'bank_card'],
    // 会议链接里常带着一次性的 token
    [/https?:\/\/\S*(?:meeting|zoom|tencent|feishu|voov)\S*/gi, '[会议链接]', 'meeting_link'],
  ];
  for (const [re, mask, name] of rules) {
    if (re.test(t)) {
      removed.push(name);
      t = t.replace(re, mask);
    }
  }
  return { text: t, removed: [...new Set(removed)] };
}

/**
 * 确定性分类：能用规则判的就别问模型。
 *
 * 返回 null 表示「规则判不了」—— 那时候才轮到模型，
 * 而且喂给模型的是脱敏后的正文。
 */
export function classifyBySubject(subject: string): MailCategory | null {
  const s = subject ?? '';
  if (/(面试邀请|邀请您参加面试|面试通知|安排面试|interview\s*(invitation|confirmed|scheduled))/i.test(s)) {
    return 'interview_invite';
  }
  if (/(很遗憾|不合适|未通过|感谢您的关注.*另有|regret|unfortunately|not\s*(move|proceed|selected))/i.test(s)) {
    return 'rejection';
  }
  if (/(录用通知|offer\s*letter|录取)/i.test(s)) return 'offer';
  if (/(笔试|在线测评|机试|online\s*assessment|coding\s*test)/i.test(s)) return 'assessment';
  if (/(简历已投递|投递成功|收到您的简历|application\s*received|thank\s*you\s*for\s*applying)/i.test(s)) {
    return 'application_ack';
  }
  return null;
}

/** 分类 → application_events 的 event_type。 */
export const CATEGORY_TO_EVENT: Record<MailCategory, string | null> = {
  application_ack: 'acknowledged',
  interview_invite: 'interview',
  rejection: 'rejected',
  offer: 'offer',
  assessment: 'assessment',
  recruiter_outreach: null, // 猎头主动来信不属于某一条投递
  unrelated: null,
};
