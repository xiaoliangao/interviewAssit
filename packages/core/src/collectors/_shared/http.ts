/**
 * 采集器共用的 HTTP 层。
 *
 * 每个采集器都必须走这里，因为重试、退避、超时、限频这四件事，
 * 是采集代码里最容易写错、也最容易在出事时才被发现的部分。
 * 散在各个平台模块里各写一遍，结果就是四种不同的错法。
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
  }
}

export class RateLimited extends Error {
  constructor(readonly url: string, readonly retryAfterMs: number | null) {
    super(`被限频：${url}${retryAfterMs ? `，建议等待 ${Math.round(retryAfterMs / 1000)}s` : ''}`);
    this.name = 'RateLimited';
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  /** 首次退避基数，实际等待是 base * 2^n + 抖动 */
  backoffBaseMs?: number;
  headers?: Record<string, string>;
  /** 注入用，测试时替换掉真实网络 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * 本工具是个人本地工具，UA 如实声明自己是什么。
 *
 * 伪装成浏览器是「模拟一个并不存在的用户」那一侧的行为 —— 而这条通道
 * 拉的是公开发布的招聘信息，本来就不需要伪装。
 */
export const USER_AGENT = 'assit-interview/0.1 (personal job-search tool; +local)';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 5xx 和 429 值得重试；4xx 是你请求写错了，重试多少次都一样。 */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return secs * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

export interface FetchResult {
  status: number;
  body: string;
  url: string;
  attempts: number;
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 3;
  const base = opts.backoffBaseMs ?? 500;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 指数退避 + 抖动。没有抖动的话，多个采集器会在同一毫秒一起重试。
      const wait = base * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(Math.min(wait, 30_000));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...opts.headers },
        signal: opts.signal ?? ctrl.signal,
      });
      const body = await res.text();
      if (res.ok) return { status: res.status, body, url, attempts: attempt + 1 };

      if (res.status === 429) {
        const after = parseRetryAfter(res.headers.get('retry-after'));
        // 明确告诉我们限频了就停手，别继续撞。
        if (attempt >= retries) throw new RateLimited(url, after);
        if (after) await sleep(Math.min(after, 60_000));
        lastErr = new RateLimited(url, after);
        continue;
      }
      if (!isRetryable(res.status)) throw new HttpError(res.status, url, body);
      lastErr = new HttpError(res.status, url, body);
    } catch (e) {
      if (e instanceof HttpError || e instanceof RateLimited) {
        if (e instanceof HttpError && !isRetryable(e.status)) throw e;
        lastErr = e;
      } else if ((e as Error).name === 'AbortError') {
        lastErr = new Error(`请求超时（${timeoutMs}ms）：${url}`);
      } else {
        lastErr = e as Error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`请求失败：${url}`);
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const r = await fetchText(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new Error(`${url} 返回的不是合法 JSON（前 200 字）：${r.body.slice(0, 200)}`);
  }
}

/**
 * 串行 + 固定间隔。
 *
 * 刻意不做并发。岗位采集不是吞吐敏感的场景 —— 你一次拉 200 个岗位，
 * 串行多花的那几十秒毫无影响，但并发打过去可能让对方把你限掉，
 * 之后连串行都拉不动了。
 */
export async function serialMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: { intervalMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<R[]> {
  const interval = opts.intervalMs ?? 300;
  const out: R[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await sleep(interval);
    out.push(await fn(items[i]!, i));
    opts.onProgress?.(i + 1, items.length);
  }
  return out;
}
