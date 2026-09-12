import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, shell } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 两件事必须在 import core 之前做完，因为 core 读的是 process.env。
 *
 * 1. 原生模块的 ABI：Node 和 Electron 不同，仓库里放的是 Node 那份，
 *    Electron 那份单独放在 apps/desktop/native/（见 core/db/index.ts 的注释）。
 * 2. 数据目录：core 默认用 cwd/data，而 Electron 的 cwd 不可预期。
 *    显式指到仓库根的 data/，和 CLI 用同一份 —— 否则你会有两个岗位池。
 */
function bootstrapEnv(): void {
  // 从构建产物自己的位置往上推，不用 app.getAppPath()：
  // 后者的返回值取决于怎么启动（electron <file> / electron <dir> / 打包后），
  // 实测拿到的不是 apps/desktop，于是原生模块的路径解析直接落空。
  // here = apps/desktop/out/main，往上两级是包根，四级是仓库根。
  const pkgRoot = path.resolve(here, '../..');
  const repoRoot = path.resolve(here, '../../../..');

  const nativeBinding = path.resolve(pkgRoot, 'native/better_sqlite3.node');
  if (!process.env.ASSIT_SQLITE_NATIVE_BINDING) {
    if (!existsSync(nativeBinding)) {
      // 不拦下来的话，下一步会掉进 better-sqlite3 的
      // 「NODE_MODULE_VERSION 127 vs 130」—— 那句话对不知情的人毫无信息量。
      throw new Error(
        `缺少 Electron ABI 的 better-sqlite3：\n  ${nativeBinding}\n\n` +
          '跑一次 `pnpm desktop:native` 拉下来。\n' +
          '（它是平台相关的二进制，所以不进 git；Node 那份仍在原位供 CLI 和测试用。）',
      );
    }
    process.env.ASSIT_SQLITE_NATIVE_BINDING = nativeBinding;
  }
  if (!process.env.ASSIT_DATA_DIR) {
    process.env.ASSIT_DATA_DIR = path.resolve(repoRoot, 'data');
  }
  // 注册表进 git、随代码走，所以挂在仓库根而不是 data/ 下面。
  // core 默认从 cwd 往上找，而 Electron 的 cwd 同样不可预期 —— 显式指过去。
  if (!process.env.ASSIT_REGISTRY_DIR) {
    process.env.ASSIT_REGISTRY_DIR = path.resolve(repoRoot, 'vendor/employer-registry');
  }
}
bootstrapEnv();

const { registerIpc } = await import('./ipc.js');

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(here, '../preload/index.mjs'),
      // 渲染进程不碰 Node，所有能力经 preload 白名单暴露。
      // 岗位池里显示的是抓回来的第三方文本，把 Node 开给它没有任何好处。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 渲染层出问题时最难查的是「窗口没出来，日志里什么也没有」。
  // 把加载生命周期和渲染进程的报错都引到主进程日志里。
  const log = (m: string): void => {
    console.log(`[window] ${m}`);
    if (process.env.ASSIT_GUI_LOG) {
      appendFileSync(process.env.ASSIT_GUI_LOG, `${m}\n`, 'utf8');
    }
  };
  win.once('ready-to-show', () => {
    win.show();
    log('ready-to-show → 已显示');
  });
  win.webContents.on('did-finish-load', () => {
    log('did-finish-load');
    // --ui-check：把渲染后的正文读回来再退出。
    // 「没有报错」不等于「渲染出了内容」—— 一个空的 React 树同样安安静静。
    if (process.argv.includes('--ui-check')) {
      // 走一遍真实交互：读今日 → 点进岗位池 → 打开第一行的详情抽屉。
      // 每一步都读回正文，确认不是空树。
      const script = `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const out = {};
        await sleep(1200);
        out.today = document.body.innerText;
        const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('岗位池'));
        nav && nav.click();
        await sleep(1500);
        out.jobs = document.body.innerText;
        out.rows = document.querySelectorAll('tbody tr').length;
        const row = document.querySelector('tbody tr');
        row && row.click();
        await sleep(1200);
        out.drawer = document.querySelector('.drawer')?.innerText ?? '(抽屉未打开)';
        return JSON.stringify(out);
      })()`;
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(script)
          .then((raw: string) => {
            const r = JSON.parse(raw) as Record<string, string | number>;
            log(`ui-check 今日 ${String(r.today).length} 字符`);
            log(`ui-check 岗位池 ${r.rows} 行\n${String(r.jobs).slice(0, 700)}`);
            log(`ui-check 详情抽屉：\n${String(r.drawer).slice(0, 900)}`);
            app.exit(Number(r.rows) > 0 ? 0 : 1);
          })
          .catch((e: Error) => {
            log(`ui-check 失败：${e.message}`);
            app.exit(1);
          });
      }, 800);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    log(`did-fail-load ${code} ${desc} ${url}`),
  );
  win.webContents.on('preload-error', (_e, file, err) => log(`preload-error ${file}: ${err.message}`));
  win.webContents.on('render-process-gone', (_e, d) => log(`render-process-gone ${d.reason}`));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`renderer console: ${message}`);
  });

  // 外链一律交给系统浏览器：岗位详情里的 URL 来自第三方，
  // 不能让它在应用窗口里导航。
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (devServer && url.startsWith(devServer)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(here, '../renderer/index.html'));
  }
  return win;
}

/**
 * `--smoke`：不开窗口，把主进程真正会走的那条链路跑一遍然后退出。
 *
 * 存在的理由是原生模块：better-sqlite3 的 .node 按 ABI 编译，
 * Electron 和 Node 用的不是同一份。这件事只有在 Electron 里真开一次库
 * 才能验出来 —— 单测和 CLI 全绿也说明不了桌面壳能跑。
 */
async function smoke(): Promise<void> {
  // macOS 上 Electron 是个 .app bundle，stdout 不一定回到调用方的终端。
  // 结果同时写文件，CI 和人工核验都读文件。
  const reportFile = process.env.ASSIT_SMOKE_OUT;
  const report = (text: string, code: number): void => {
    console.log(text);
    if (reportFile) writeFileSync(reportFile, text, 'utf8');
    app.exit(code);
  };
  const out: string[] = [];
  try {
    const core = await import('@assit/core');
    out.push(`data dir       ${core.paths.data}`);
    out.push(`native binding ${process.env.ASSIT_SQLITE_NATIVE_BINDING ?? '(默认 Node ABI)'}`);
    const db = core.openDb();
    const n = db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number };
    out.push(`sqlite         ok，岗位 ${n.n} 个`);
    const v = {
      profileVersion: core.currentProfileVersion(),
      rubricVersion: (() => {
        try {
          return core.loadRubric().version;
        } catch {
          return '(未配置)';
        }
      })(),
    };
    out.push(`versions       profile=${v.profileVersion} rubric=${v.rubricVersion}`);
    const rows = core.queryJobs(db, v, { limit: 3 });
    out.push(`queryJobs      返回 ${rows.length} 行`);
    rows.forEach((r) => out.push(`               ${r.finalScore ?? '—'}  ${r.company} · ${r.title}`));
    const t = core.todaySummary(db, v);
    out.push(`todaySummary   新增 ${t.newToday}，未打分 ${t.unscored}，异常源 ${t.brokenSources.length}`);
    db.close();
    report(`SMOKE OK\n${out.map((l) => `  ${l}`).join('\n')}`, 0);
  } catch (e) {
    report(`SMOKE FAIL\n${out.map((l) => `  ${l}`).join('\n')}\n  ${(e as Error).stack}`, 1);
  }
}

void app.whenReady().then(() => {
  if (process.argv.includes('--smoke')) {
    void smoke();
    return;
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
