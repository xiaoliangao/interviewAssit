import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BridgeUnavailable,
  type BridgeTab,
  type BrowserBridge,
  type CapturedResponse,
  type OpenOptions,
} from './types.js';

const run = promisify(execFile);

/**
 * 用 [agent-browser-cli](https://github.com/sleepinginsummer/agent-browser-cli)
 * 当桥（MIT，见 vendor/THIRD_PARTY_NOTICES.md）。
 *
 * 它是**运行期外部工具**，不是 npm 依赖 —— 所以 lockfile 挡不住版本漂移。
 * 对策是每个命令的输出都过一遍形状检查，对不上就显式报错说
 * 「这个版本对不上」，而不是让 undefined 一路流进岗位池。
 */

export interface RunnerResult {
  stdout: string;
  stderr: string;
}
export type Runner = (args: string[]) => Promise<RunnerResult>;

function defaultRunner(bin: string, timeoutMs: number): Runner {
  return async (args) => {
    try {
      const { stdout, stderr } = await run(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
      return { stdout, stderr };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (err.code === 'ENOENT') {
        throw new BridgeUnavailable(
          'agent-browser-cli',
          `找不到 ${bin}。\n` +
            '  装它：npm i -g @sleepinsummer/agent-browser-cli\n' +
            '  然后在 chrome://extensions 加载它的 tmwd_cdp_bridge 扩展（开发者模式 → 加载已解压的扩展程序）。\n' +
            '  没有这座桥，BOSS / 51job 仍然可以用 `assit ingest` 手动粘贴，下游处理完全一样。',
        );
      }
      // 它自己的错误信息通常比 exit code 有用，原样带出来
      throw new Error(
        `agent-browser-cli ${args[0]} 失败：${(err.stderr || err.stdout || err.message).slice(0, 400)}`,
      );
    }
  };
}

interface Envelope<T> {
  ok?: boolean;
  result?: T;
  error?: unknown;
}

export interface AgentBrowserCliOptions {
  bin?: string;
  timeoutMs?: number;
  runner?: Runner;
}

export class AgentBrowserCliBridge implements BrowserBridge {
  readonly name = 'agent-browser-cli';
  private readonly runner: Runner;

  constructor(opts: AgentBrowserCliOptions = {}) {
    this.runner = opts.runner ?? defaultRunner(opts.bin ?? 'agent-browser-cli', opts.timeoutMs ?? 60_000);
  }

  private async json<T>(args: string[]): Promise<T> {
    const { stdout } = await this.runner(args);
    let parsed: Envelope<T>;
    try {
      parsed = JSON.parse(stdout) as Envelope<T>;
    } catch {
      throw new Error(
        `agent-browser-cli ${args[0]} 的输出不是 JSON（前 200 字）：${stdout.slice(0, 200)}\n` +
          '  多半是版本对不上 —— 它是外部工具，lockfile 挡不住它升级。',
      );
    }
    if (parsed.ok === false) {
      throw new Error(`agent-browser-cli ${args[0]}：${JSON.stringify(parsed.error).slice(0, 300)}`);
    }
    return (parsed.result ?? (parsed as unknown as T)) as T;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const tabs = await this.tabs();
      if (tabs.length === 0) {
        return {
          ok: false,
          detail:
            'Chrome 里没有可控的标签页。扩展要求至少有一个普通网页标签 ——\n' +
            '  停在 about:blank 或 chrome:// 页面上是不行的。',
        };
      }
      return { ok: true, detail: `${tabs.length} 个标签页可控` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  async tabs(): Promise<BridgeTab[]> {
    const r = await this.json<{ tabs?: any[] }>(['tabs']);
    const list = Array.isArray(r) ? r : (r.tabs ?? []);
    return list.map((t: any) => ({
      tabId: String(t.tab_id ?? t.tabId ?? t.id ?? ''),
      url: String(t.url ?? ''),
      title: String(t.title ?? ''),
    })).filter((t: BridgeTab) => t.tabId !== '');
  }

  async open(url: string, opts: OpenOptions = {}): Promise<BridgeTab> {
    const args = ['open', url];
    // 默认不抢焦点：采集时把用户正在看的窗口抢走非常恼人，
    // 而且会让「这是在加速我自己的浏览」这句话变得不成立。
    if (opts.background !== false) args.push('--background');
    const r = await this.json<any>(args);
    const tabId = String(r.opened_tab_id ?? r.openedTabId ?? r.tab_id ?? '');
    if (!tabId) {
      throw new Error(`open 没有返回 tab id，拿到的是：${JSON.stringify(r).slice(0, 200)}`);
    }
    return { tabId, url, title: '' };
  }

  async startCapture(tabId: string): Promise<void> {
    await this.json(['network', 'start', '--tab', tabId]);
  }

  async stopCapture(tabId: string): Promise<void> {
    await this.json(['network', 'stop', '--tab', tabId]).catch(() => undefined);
  }

  async capturedResponses(tabId: string, urlFilter: string): Promise<CapturedResponse[]> {
    const list = await this.json<any>(['network', 'list', '--tab', tabId, '--filter', urlFilter]);
    const reqs: any[] = Array.isArray(list) ? list : (list.requests ?? list.entries ?? []);
    const out: CapturedResponse[] = [];
    for (const r of reqs) {
      const id = String(r.request_id ?? r.requestId ?? r.id ?? '');
      const url = String(r.url ?? '');
      if (!id || !url.includes(urlFilter)) continue;
      const d = await this.json<any>(['network', 'detail', id, '--tab', tabId]);
      const body = d.body ?? d.response_body ?? d.responseBody ?? '';
      out.push({
        requestId: id,
        url,
        status: Number(r.status ?? d.status ?? 0),
        // base64 的按需解一次。它对大响应会截断并打标，这里如实往下传，
        // matcher 解析失败时会显式失败而不是产出半截数据。
        bodyText: d.base64Encoded || d.base64_encoded
          ? Buffer.from(String(body), 'base64').toString('utf8')
          : String(body),
      });
    }
    return out;
  }

  async exec(tabId: string, js: string): Promise<unknown> {
    return this.json(['exec', '--tab', tabId, js]);
  }

  async close(tabId: string): Promise<void> {
    await this.json(['close', '--tab', tabId]).catch(() => undefined);
  }
}
