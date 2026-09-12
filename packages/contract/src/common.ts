import { z } from 'zod';

/**
 * 敏感级。这是全系统的硬约束，不是标签 —— 路由层据此拦截
 * （DESIGN §10.3 / §13.4，plan §3.1）。
 */
export const Visibility = z.enum(['public', 'private', 'nda']);
export type Visibility = z.infer<typeof Visibility>;

export const VIS_RANK: Record<Visibility, number> = { public: 0, private: 1, nda: 2 };

/** ISO 日期 YYYY-MM-DD，或年月 YYYY-MM。事实库里日期一律写全，不接受自然语言。 */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, '日期必须是 YYYY-MM 或 YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

/**
 * 三态字段（DESIGN §6.1）。「未知就是未知」的数据落点：
 * value 为 null 且 confidence 为 unknown 时，该维度不计入打分分母。
 */
export const Confidence = z.enum(['explicit_jd', 'inferred', 'user_provided', 'unknown']);
export type Confidence = z.infer<typeof Confidence>;

export function tristate<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    value: inner.nullable(),
    confidence: Confidence,
    source: z.string().nullable().default(null),
  });
}

export type Tristate<T> = { value: T | null; confidence: Confidence; source: string | null };

export const UNKNOWN: Tristate<never> = { value: null, confidence: 'unknown', source: null };
