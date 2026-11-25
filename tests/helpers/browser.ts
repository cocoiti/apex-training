// 受け入れテストで、ビルドの結果を実際のブラウザ（ヘッドレスの Chromium）で開くための小さな道具。
// 依存を増やさないよう、Playwright が置いた Chromium を DevTools プロトコルで直接動かす。
// Chromium は環境変数 CHROMIUM_PATH か、~/Library/Caches/ms-playwright（Linux は ~/.cache/ms-playwright）から探す。
// ポインターロックが使えるよう、chrome-headless-shell より通常の Chromium（Chrome for Testing）を先に選ぶ。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { listenOnFreePort } from './server';
import { waitUntil } from './wait';

export { listenOnFreePort, originOf, portOf } from './server';
export { waitUntil } from './wait';

/** 使える Chromium の実行ファイルを探す。見つからなければ undefined。 */
export function findChromium(): string | undefined {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const caches = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const dirs = readdirSync(cache).sort().reverse();
    for (const dir of dirs.filter((d) => d.startsWith('chromium-'))) {
      for (const bin of [
        join(cache, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        join(cache, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(cache, dir, 'chrome-linux/chrome'),
        join(cache, dir, 'chrome-linux64/chrome'),
      ]) {
        if (existsSync(bin)) return bin;
      }
    }
    for (const dir of dirs.filter((d) => d.startsWith('chromium_headless_shell-'))) {
      for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const bin = join(cache, dir, sub, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  return undefined;
}

/** dir を base のサブパスの下にだけ置く静的なサーバー（ほかのパスは 404）。ポートは OS が選ぶ（originOf で読む）。 */
export async function serveStatic(dir: string, base: string): Promise<Server> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (!path.startsWith(base)) return void res.writeHead(404).end();
    let file = normalize(join(dir, path.slice(base.length)));
    if (!file.startsWith(dir)) return void res.writeHead(404).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  return listenOnFreePort(server);
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** DevTools プロトコルで 1 つのタブを動かす。 */
export class Page {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** ページで捕まらなかった例外とコンソールのエラー。 */
  readonly errors: string[] = [];

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.exceptionDetails as { text?: string; exception?: { description?: string } };
        this.errors.push(`exception: ${details.exception?.description ?? details.text ?? ''}`);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const args = (msg.params.args as { value?: unknown; description?: string }[]) ?? [];
        this.errors.push(`console.error: ${args.map((a) => String(a.value ?? a.description ?? '')).join(' ')}`);
      }
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /** 式をページで評価し、結果の値を返す（Promise は待つ）。 */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value as T;
  }

  /** 文書が読み込まれるたび、ページのスクリプトより先に実行するスクリプトを足す。 */
  async addInitScript(source: string): Promise<void> {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  /** url を開き、読み込みが終わるまで待つ。 */
  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"');
  }

  /** ページの式が真になるまで待つ。timeout を過ぎたら、待っていた式を示して失敗する。 */
  async waitFor(expression: string, timeout = 10_000): Promise<void> {
    await waitUntil(() => this.evaluate<boolean>(`Boolean(${expression})`), `ページの式が真になる: ${expression}`, { timeout });
  }

  /**
   * ページが n 回描画される（requestAnimationFrame の呼び出しが n 回進む）まで待つ。
   * 見た目を変えたあとに画面写しを撮る前や、止まっている間に描画が進んでも変わらないことを確かめるときに使う。
   * 待ちの条件は描画が進み続けていること。マシンが重いと描画の間隔は伸びるので、n 回全体には上限を置かず、
   * 1 回の描画が stall ms 来ない（描画が止まった）ときに、何回目で止まったかを示して失敗する（ARC-20）。
   */
  async frames(n = 2, stall = 10_000): Promise<void> {
    const drawn = await this.evaluate<number>(`new Promise((resolve) => {
      let count = 0;
      let timer;
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => resolve(count), ${stall}); };
      const next = () => { count += 1; if (count >= ${n}) { clearTimeout(timer); resolve(count); } else { arm(); requestAnimationFrame(next); } };
      arm();
      requestAnimationFrame(next);
    })`);
    if (drawn < n) throw new Error(`${n} 回の描画を待つ途中、${drawn} 回目のあと ${stall} ms 描画が進まない`);
  }

  /**
   * 画面写し（PNG）。圧縮を軽くして（optimizeForSpeed、画素は変わらない）撮るのにかかる時間を短くする。
   * 撮るあいだも練習の時計は進むので、マシンが重いときに撮り終わる前に次の画面へ移らないように（ARC-20）。
   */
  async screenshot(): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(data, 'base64');
  }

  /**
   * 続けて撮った画面写しが同じになる（動きが止まる。リコイルの戻りや照準の動きが描画し終わる）まで待ち、その画面写しを返す。
   */
  async stableScreenshot(timeout = 10_000): Promise<Buffer> {
    let previous = await this.screenshot();
    return waitUntil(
      async () => {
        await this.frames(2);
        const current = await this.screenshot();
        const same = current.equals(previous);
        previous = current;
        return same && current;
      },
      '続けて撮った画面写しが同じになる（画面の動きが止まる）',
      { timeout, interval: 0 },
    );
  }

  /**
   * act（クリックなど）でポインターロックを要求し、ロックが掛かるか拒否されるまで待つ。掛かったら true。
   * 決まった時間を待つ代わりに、pointerlockchange / pointerlockerror の知らせを待つ。
   */
  async lockPointerBy(act: () => Promise<void>, timeout = 5_000): Promise<boolean> {
    await this.evaluate(`window.__lockSettled = new Promise((resolve) => {
      const done = () => { document.removeEventListener('pointerlockchange', done); document.removeEventListener('pointerlockerror', done);
        resolve(!!document.pointerLockElement); };
      document.addEventListener('pointerlockchange', done); document.addEventListener('pointerlockerror', done);
      setTimeout(() => resolve(!!document.pointerLockElement), ${timeout});
    }); true`);
    await act();
    return this.evaluate<boolean>('window.__lockSettled');
  }

  /** ビューポートの座標 (x, y) をマウスでクリックする。 */
  async click(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  /** マウスを (x, y) へ動かす。 */
  async moveMouse(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  /** CSS セレクタに当たる最初の要素の中心をクリックする。 */
  async clickSelector(selector: string): Promise<void> {
    const box = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!box) throw new Error(`要素がない: ${selector}`);
    await this.click(box.x, box.y);
  }
}

export interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/**
 * ヘッドレスの Chromium を起動する。DevTools のポートは Chromium に空いているものを選ばせ（--remote-debugging-port=0）、
 * プロファイルの DevToolsActivePort から読む（ARC-18, ARC-19）。プロファイルは起動ごとに一時ディレクトリに作る。
 */
export async function launchBrowser(executable: string): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'acceptance-chromium-'));
  const child: ChildProcess = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1280,800',
      // 重いマシンでも描画やタイマーを間引かせない（画面が隠れている・裏にあると見なされて止まらないように）。
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  let endpoint: string;
  try {
    endpoint = await waitUntil(
      async () => {
        // 選ばれたポートは、プロファイルの DevToolsActivePort の 1 行目に書かれる。
        const file = join(profile, 'DevToolsActivePort');
        if (!existsSync(file)) return undefined;
        const port = readFileSync(file, 'utf8').split('\n')[0]?.trim();
        if (!port) return undefined;
        const url = `http://127.0.0.1:${port}`;
        const res = await fetch(`${url}/json/version`);
        return res.ok && url;
      },
      'Chromium が起動し、DevTools のポートが応答する',
      { timeout: 15_000, interval: 100 },
    );
  } catch (error) {
    child.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  const sockets: WebSocket[] = [];
  return {
    async newPage() {
      const res = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' });
      const target = (await res.json()) as { webSocketDebuggerUrl: string };
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((ok, ng) => {
        socket.addEventListener('open', () => ok());
        socket.addEventListener('error', () => ng(new Error('DevTools に接続できない')));
      });
      sockets.push(socket);
      const page = new Page(socket);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      await page.send('Page.bringToFront');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      return page;
    },
    async close() {
      for (const s of sockets) s.close();
      // 終わったことを確かめてからプロファイルを消す（決まった時間は待たない）。
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
