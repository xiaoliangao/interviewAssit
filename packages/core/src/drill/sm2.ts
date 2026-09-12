/**
 * SM-2 间隔重复（DESIGN §9）。
 *
 * 刻意自己写这 50 行而不是引一个库：SM-2 本身就这么大，
 * 而引进来的库会带着自己的存储假设，把「错题来源加权」这件事挡在门外。
 */

export interface ReviewState {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
}

export const INITIAL: ReviewState = { easeFactor: 2.5, intervalDays: 0, repetitions: 0 };

/** 0–5。<3 算没答上来，要重来。 */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * 错题来源的权重。
 *
 * **真实面试答错 > 模拟面试答错 > 日常刷题答错。**
 * 理由很实在：真实面试里答错的题，是有人真的拿它筛过你。
 * 日常刷题错一道，可能只是那天状态不好。
 *
 * 权重作用在间隔上：来源越重，重复得越密。
 */
export const ORIGIN_WEIGHT: Record<string, number> = {
  real_interview: 0.6, // 间隔打六折 —— 更快再见到它
  mock_interview: 0.8,
  drill: 1.0,
  claim_derived: 0.7, // 从自己主张长出来的题，答不上来直接关系到简历
};

export function nextReview(
  state: ReviewState,
  grade: Grade,
  origin = 'drill',
): ReviewState & { dueInDays: number } {
  let { easeFactor, intervalDays, repetitions } = state;

  if (grade < 3) {
    // 没答上来：重复次数归零，明天再见。
    // 不把 easeFactor 也归零 —— 一次失手不该抹掉这道题长期的难度画像。
    repetitions = 0;
    intervalDays = 1;
  } else {
    repetitions += 1;
    intervalDays = repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round(intervalDays * easeFactor);
  }

  easeFactor = Math.max(
    1.3, // SM-2 的下限。再低会让难题以近乎每天的频率出现，最后你会关掉整个功能
    easeFactor + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)),
  );

  const weight = ORIGIN_WEIGHT[origin] ?? 1;
  const dueInDays = Math.max(1, Math.round(intervalDays * weight));
  return { easeFactor, intervalDays, repetitions, dueInDays };
}

export function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}
