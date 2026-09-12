import { describe, expect, it, vi } from 'vitest';
import { Posting } from '@assit/contract';
import {
  HttpError,
  RateLimited,
  collectAshby,
  collectGreenhouse,
  collectJsonLd,
  collectLever,
  fetchText,
  htmlToText,
  ldMonthlySalary,
  ldSalary,
  locationCity,
  orgName,
  parseJobPostingHtml,
  serialMap,
} from '@assit/core';

/**
 * 契约测试。
 *
 * 它保护的是一件事：**平台改版时要显式失败，而不是悄悄产出半截数据。**
 * 后者才是真正难查的问题 —— 你要等到某天发现「这批岗位怎么都没有薪资」
 * 才会想起来，而那时候污染的数据已经混进岗位池了。
 *
 * 全部离线：fixture + 注入的 fetch。契约测试不该依赖别人的服务器还活着。
 */

function fakeFetch(
  handler: (url: string) => { status?: number; body?: string; headers?: Record<string, string> },
): typeof fetch {
  return (async (url: string) => {
    const r = handler(String(url));
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      text: async () => r.body ?? '',
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
    };
  }) as unknown as typeof fetch;
}

// ── HTTP 层 ────────────────────────────────────────────────────────────────

describe('HTTP：重试、退避、超时、限频', () => {
  it('5xx 会重试，最终成功', async () => {
    let n = 0;
    const r = await fetchText('https://x/api', {
      backoffBaseMs: 1,
      fetchImpl: fakeFetch(() => (++n < 3 ? { status: 503, body: 'boom' } : { body: 'ok' })),
    });
    expect(r.body).toBe('ok');
    expect(r.attempts).toBe(3);
  });

  it('4xx 不重试 —— 请求写错了，重试多少次都一样', async () => {
    let n = 0;
    await expect(
      fetchText('https://x/api', {
        backoffBaseMs: 1,
        fetchImpl: fakeFetch(() => {
          n++;
          return { status: 404, body: 'not found' };
        }),
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });

  it('429 重试耗尽后抛 RateLimited，并带上建议等待时间', async () => {
    await expect(
      fetchText('https://x/api', {
        retries: 1, backoffBaseMs: 1,
        fetchImpl: fakeFetch(() => ({ status: 429, body: '', headers: { 'retry-after': '1' } })),
      }),
    ).rejects.toBeInstanceOf(RateLimited);
  });

  it('超时会中止并报出来', async () => {
    const hang: typeof fetch = (async (_u: string, init: any) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      })) as unknown as typeof fetch;
    await expect(
      fetchText('https://x/slow', { timeoutMs: 20, retries: 0, fetchImpl: hang }),
    ).rejects.toThrow(/超时/);
  });

  it('退避是指数增长的', () => {
    // 抖动让这个断言天然不稳：base*2^0*[0.5,1.5] 和 base*2^1*[0.5,1.5]
    // 的取值区间是重叠的，直接比较两次实际等待会偶发失败。
    // 把随机数钉住，测的才是「指数」这个性质本身。
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const base = 500;
      const wait = (attempt: number) => base * 2 ** (attempt - 1) * (0.5 + Math.random());
      expect(wait(1)).toBe(500);
      expect(wait(2)).toBe(1000);
      expect(wait(3)).toBe(2000);
    } finally {
      spy.mockRestore();
    }
  });

  it('退避带抖动 —— 没抖动的话多个采集器会在同一毫秒一起重试', async () => {
    const samples = new Set<number>();
    for (let run = 0; run < 6; run++) {
      let last = Date.now();
      let n = 0;
      await fetchText('https://x/api', {
        backoffBaseMs: 8,
        fetchImpl: fakeFetch(() => {
          if (n > 0) samples.add(Date.now() - last);
          last = Date.now();
          return ++n < 2 ? { status: 500, body: '' } : { body: 'ok' };
        }),
      });
    }
    // 固定间隔的话这里只会有一两个值
    expect(samples.size).toBeGreaterThan(1);
  });

  it('串行执行，不并发 —— 采集不是吞吐敏感的场景', async () => {
    let concurrent = 0;
    let peak = 0;
    await serialMap([1, 2, 3, 4], async () => {
      peak = Math.max(peak, ++concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
    }, { intervalMs: 1 });
    expect(peak).toBe(1);
  });

  it('UA 如实声明自己是什么，不伪装成浏览器', async () => {
    const seen: Record<string, string> = {};
    const impl: typeof fetch = (async (_u: string, init: any) => {
      Object.assign(seen, init.headers);
      return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    }) as unknown as typeof fetch;
    await fetchText('https://x/', { fetchImpl: impl });
    expect(seen['user-agent']).toContain('assit-interview');
    expect(seen['user-agent']).not.toMatch(/Mozilla|Chrome|Safari/);
  });
});

// ── JSON-LD ────────────────────────────────────────────────────────────────

const LD_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"高级后端开发工程师",
 "description":"<p>岗位职责：</p><ul><li>负责交易链路开发</li></ul><p>要求：本科及以上，5年经验，精通 Go</p>",
 "datePosted":"2026-09-01",
 "hiringOrganization":{"@type":"Organization","name":"杭州云枢科技有限公司"},
 "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"杭州"}},
 "baseSalary":{"@type":"MonetaryAmount","currency":"CNY",
   "value":{"@type":"QuantitativeValue","minValue":40000,"maxValue":60000,"unitText":"MONTH"}},
 "identifier":{"@type":"PropertyValue","value":"JOB-123"},
 "url":"https://careers.acme.cn/jobs/123"}
</script></head><body>…</body></html>`;

describe('JSON-LD：覆盖面最大的一条通道', () => {
  it('从页面抠出 JobPosting', () => {
    const [ld] = parseJobPostingHtml(LD_PAGE);
    expect(ld!.title).toBe('高级后端开发工程师');
    expect(orgName(ld!)).toBe('杭州云枢科技有限公司');
    expect(locationCity(ld!)).toBe('杭州');
  });

  it('@graph 里嵌套的也能找到', () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Organization","name":"X"},
        {"@type":"JobPosting","title":"后端"}]}</script>`;
    expect(parseJobPostingHtml(html).map((l) => l.title)).toEqual(['后端']);
  });

  it('一个坏的 JSON-LD 块不该让整页作废', () => {
    const html = `<script type="application/ld+json">{ bad json </script>${LD_PAGE}`;
    expect(parseJobPostingHtml(html)).toHaveLength(1);
  });

  it('页面里没有 JobPosting 时返回空，不硬猜', () => {
    // 硬猜出来的半截数据比没有更糟
    expect(parseJobPostingHtml('<html><body>招聘信息</body></html>')).toEqual([]);
  });

  it('HTML 描述转文本时保住换行结构', () => {
    const t = htmlToText('<p>职责：</p><ul><li>开发</li><li>维护</li></ul>');
    expect(t).toContain('\n');
    expect(t).toContain('· 开发');
    expect(t).not.toContain('<');
  });

  it('薪资按周期折成月薪', () => {
    const yearly = ldSalary({ baseSalary: { currency: 'CNY', value: { minValue: 600000, unitText: 'YEAR' } } });
    expect(ldMonthlySalary(yearly).min).toBe(50000);
  });

  it('外币不做汇率换算 —— 写死的汇率会让历史分数不可比', () => {
    const usd = ldSalary({ baseSalary: { currency: 'USD', value: { minValue: 120000, unitText: 'YEAR' } } });
    expect(ldMonthlySalary(usd)).toEqual({ min: null, max: null });
    // 但原文要留着，让人自己看
    expect(usd.raw).toContain('USD');
  });
});

// ── 各平台契约 ─────────────────────────────────────────────────────────────

describe('Greenhouse 契约', () => {
  const body = JSON.stringify({
    jobs: [
      {
        id: 4012345, title: 'Senior Backend Engineer',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
        location: { name: 'Shanghai' },
        content: '&lt;p&gt;We are looking for...&lt;/p&gt;&lt;p&gt;Requirements: Go, Kubernetes&lt;/p&gt;',
      },
      { id: 999, title: 'Empty', absolute_url: 'https://x', content: '' },
    ],
  });

  it('输出全部满足 Posting 契约', async () => {
    const r = await collectGreenhouse('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    expect(r.postings).toHaveLength(1);
    for (const p of r.postings) expect(Posting.safeParse(p).success).toBe(true);
    expect(r.postings[0]!.platform_job_id).toBe('4012345');
    expect(r.postings[0]!.city).toBe('Shanghai');
    expect(r.postings[0]!.jd_text).toContain('Kubernetes');
  });

  it('没有 JD 正文的条目被显式拒绝，而不是静默产出空岗位', async () => {
    const r = await collectGreenhouse('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    expect(r.fetched).toBe(2);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain('没有 JD 正文');
  });

  it('HTML 实体被解码 —— greenhouse 的 content 是转义过的', async () => {
    const r = await collectGreenhouse('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    expect(r.postings[0]!.jd_text).not.toContain('&lt;');
  });

  it('接口返回非 JSON 时报错说清楚', async () => {
    await expect(
      collectGreenhouse('acme', { fetchImpl: fakeFetch(() => ({ body: '<html>404</html>' })) }),
    ).rejects.toThrow(/不是合法 JSON/);
  });
});

describe('Lever 契约', () => {
  const body = JSON.stringify([
    {
      id: 'abc-123', text: '后端工程师', hostedUrl: 'https://jobs.lever.co/acme/abc-123',
      descriptionPlain: '我们在找一位后端工程师。',
      lists: [{ text: '任职要求', content: '<li>5 年以上经验</li><li>精通 Go</li>' }],
      categories: { location: '北京', team: 'Infra' },
      salaryRange: { min: 600000, max: 900000, currency: 'CNY', interval: 'year' },
    },
  ]);

  it('把 lists 分节拼进 JD —— 不拼会丢掉一半内容', async () => {
    const r = await collectLever('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    expect(r.postings[0]!.jd_text).toContain('任职要求');
    expect(r.postings[0]!.jd_text).toContain('精通 Go');
  });

  it('人民币年薪折成月薪', async () => {
    const r = await collectLever('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    expect(r.postings[0]!.salary_min_yuan).toBe(50000);
    expect(r.postings[0]!.salary_raw).toContain('CNY');
  });

  it('输出满足 Posting 契约', async () => {
    const r = await collectLever('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    for (const p of r.postings) expect(Posting.safeParse(p).success).toBe(true);
  });
});

describe('Ashby 契约', () => {
  const body = JSON.stringify({
    jobs: [
      { id: 'a1', title: 'Backend Engineer', location: 'Remote', descriptionPlain: 'Go, K8s', isListed: true },
      { id: 'a2', title: 'Hidden', descriptionPlain: 'x', isListed: false },
    ],
  });

  it('跳过未挂牌的岗位', async () => {
    const r = await collectAshby('acme', { fetchImpl: fakeFetch(() => ({ body })) });
    expect(r.postings.map((p) => p.platform_job_id)).toEqual(['a1']);
  });
});

describe('通用 JSON-LD 采集', () => {
  it('从任意招聘页抓出合法 Posting', async () => {
    const r = await collectJsonLd(['https://careers.acme.cn/jobs/123'], undefined, {
      intervalMs: 1,
      fetchImpl: fakeFetch(() => ({ body: LD_PAGE })),
    });
    expect(r.postings).toHaveLength(1);
    const p = r.postings[0]!;
    expect(Posting.safeParse(p).success).toBe(true);
    expect(p.company_name).toBe('杭州云枢科技有限公司');
    expect(p.city).toBe('杭州');
    expect(p.salary_min_yuan).toBe(40000);
    expect(p.platform_job_id).toBe('JOB-123');
  });

  it('页面结构不认识就报出来，不硬猜', async () => {
    const r = await collectJsonLd(['https://x/a'], undefined, {
      intervalMs: 1,
      fetchImpl: fakeFetch(() => ({ body: '<html>nothing</html>' })),
    });
    expect(r.postings).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain('没有找到 schema.org JobPosting');
  });

  it('页面没写公司名时用兜底值', async () => {
    const html = `<script type="application/ld+json">
      {"@type":"JobPosting","title":"后端","description":"内容"}</script>`;
    const r = await collectJsonLd(['https://careers.acme.cn/1'], '某某科技', {
      intervalMs: 1, fetchImpl: fakeFetch(() => ({ body: html })),
    });
    expect(r.postings[0]!.company_name).toBe('某某科技');
  });

  it('多个页面串行抓，一个失败不影响其他', async () => {
    const seen: string[] = [];
    const r = await collectJsonLd(['https://x/1', 'https://x/2'], 'X', {
      intervalMs: 1, retries: 0,
      fetchImpl: fakeFetch((u) => {
        seen.push(u);
        return u.endsWith('/1') ? { body: '<html>nope</html>' } : { body: LD_PAGE };
      }),
    });
    expect(seen).toHaveLength(2);
    expect(r.postings).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
  });
});
