/**
 * 浏览器桥（DESIGN §4.2 ④）。
 *
 * 通道 B 的内核不直接说 CDP，只说这一层。原因是「怎么接管浏览器」
 * 这件事换过一次方案，还可能再换：
 *
 *   - `--remote-debugging-port`：要带 flag 重启 Chrome（关掉用户所有标签页），
 *     而新版 Chrome 已禁止对默认用户目录开远程调试 —— 桌面端不成立
 *   - **MV3 扩展 + `chrome.debugger.attach`**：挂到用户正在用的 Chrome 上，
 *     不重启、不换 profile、不碰凭据 ← 现在走这条
 *
 * 换桥不该动 `SiteMatcher`，更不该动打分和入库。所以边界画在这里。
 */

export interface BridgeTab {
  tabId: string;
  url: string;
  title: string;
}

export interface CapturedResponse {
  requestId: string;
  url: string;
  status: number;
  /** 页面自己拿到的响应体。工具只读，不重放、不改写 */
  bodyText: string;
}

export interface OpenOptions {
  /** 不抢焦点。采集时把用户的窗口抢走是很恼人的 */
  background?: boolean;
  timeoutMs?: number;
}

export interface BrowserBridge {
  readonly name: string;
  /** 桥是否可用。**不可用要给出可执行的下一步**，不是一句「失败」 */
  health(): Promise<{ ok: boolean; detail: string }>;
  tabs(): Promise<BridgeTab[]>;
  open(url: string, opts?: OpenOptions): Promise<BridgeTab>;
  /** 开始旁听。之后页面自己发的请求都会被记下来 */
  startCapture(tabId: string): Promise<void>;
  /** 取回旁听到的响应。urlFilter 用来只要岗位接口那几条 */
  capturedResponses(tabId: string, urlFilter: string): Promise<CapturedResponse[]>;
  stopCapture(tabId: string): Promise<void>;
  /** 在页面里执行 JS。滚动加载靠它 —— 但**不用它发请求** */
  exec(tabId: string, js: string): Promise<unknown>;
  close(tabId: string): Promise<void>;
}

export class BridgeUnavailable extends Error {
  constructor(readonly bridge: string, detail: string) {
    super(detail);
    this.name = 'BridgeUnavailable';
  }
}
