// 受け入れテストで、ビルドの結果を実際のブラウザ（ヘッドレスの Chromium）で開くための小さな道具。
// 依存を増やさないよう、Playwright が置いた Chromium を DevTools プロトコルで直接動かす。
// Chromium は環境変数 CHROMIUM_PATH か、~/Library/Caches/ms-playwright（Linux は ~/.cache/ms-playwright）から探す。
// ポインターロックが使えるよう、chrome-headless-shell より通常の Chromium（Chrome for Testing）を先に選ぶ。
// 環境変数 APEX_REQUIRE_CHROMIUM が 1 のとき（CI）は、見つからなければテストを飛ばさずに失敗する（docs/spec/architecture.md ARC-47）。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { listenOnFreePort } from './server';
import { waitUntil } from './wait';

export { listenOnFreePort, originOf, portOf } from './server';
export { waitUntil } from './wait';

/** 1 のとき、Chromium が見つからなければ findChromium が例外を投げる環境変数（CI で設定する）。 */
export const REQUIRE_CHROMIUM_ENV = 'APEX_REQUIRE_CHROMIUM';

/**
 * 使える Chromium の実行ファイルを探す。見つからなければ undefined（ブラウザを使うテストは飛ばす）。
 * ただし env の APEX_REQUIRE_CHROMIUM が 1 なら、見つからないときは探した場所を示して例外を投げる。
 * テストのファイルの読み込みが失敗になるので、CI でブラウザを使うテストが飛ばされて成功になることがない（ARC-47）。
 */
export function findChromium(env: Record<string, string | undefined> = process.env, home: string = homedir()): string | undefined {
  const caches = [join(home, 'Library/Caches/ms-playwright'), join(home, '.cache/ms-playwright')];
  const found = searchChromium(env.CHROMIUM_PATH, caches);
  if (found === undefined && env[REQUIRE_CHROMIUM_ENV]?.trim() === '1') {
    throw new Error(`${REQUIRE_CHROMIUM_ENV}=1 なのに Chromium が見つからない（CHROMIUM_PATH: ${JSON.stringify(env.CHROMIUM_PATH ?? '')}、探した場所: ${caches.join(', ')}）`);
  }
  return found;
}

function searchChromium(fromEnv: string | undefined, caches: string[]): string | undefined {
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
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

/** テストのためにページの URL のクエリに付ける振る舞い（docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」）。 */
export interface AppUrlOptions {
  /** false なら render=off（3D を描画しない）。既定は描画する。 */
  render?: boolean;
  /** true なら clock=manual（ページの時計を Page.advanceClock で進める）。 */
  manualClock?: boolean;
}

/** origin + base のページを、テストのためのクエリと hash（#/ など）を付けて開く URL。 */
export function appUrl(origin: string, base: string, hash = '#/', { render = true, manualClock = false }: AppUrlOptions = {}): string {
  const params = new URLSearchParams();
  if (!render) params.set('render', 'off');
  if (manualClock) params.set('clock', 'manual');
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return `${origin}${base}${query}${hash}`;
}

/** DevTools プロトコルで 1 つのタブを動かす。 */
export class Page {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** ページで捕まらなかった例外とコンソールのエラー。 */
  readonly errors: string[] = [];
  /** DevTools プロトコルの知らせ（method ごと）を受け取るもの。 */
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

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
      if (msg.method) for (const listener of this.listeners.get(msg.method) ?? []) listener(msg.params ?? {});
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

  /** DevTools プロトコルの知らせ（Network.requestWillBeSent・Fetch.requestPaused など）を受け取る。 */
  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /**
   * clock=manual で開いたページの時計を seconds 秒進める（frame 秒ごとに描画を行い、実時間では待たない）。
   * frame の既定は 1/60 秒。3D を描画するページで長く進めるときは、描画の回数を減らすよう frame を長くする（1 回の描画で進むのは 0.25 秒まで）。
   * 行った描画の回数を返す。
   */
  async advanceClock(seconds: number, frame?: number): Promise<number> {
    return this.evaluate<number>(`(() => {
      const clock = window.__apexTestClock;
      if (!clock) throw new Error('clock=manual で開いたページではない');
      return clock.advance(${seconds}${frame === undefined ? '' : `, ${frame}`});
    })()`);
  }

  /**
   * clock=manual で開いたページの時計を step 秒ずつ進め（1 回進めるごとに描画を 1 回行う）、式が真になったら止める（真になった時点の時計で止まる）。
   * 時計を limit 秒進めても真にならなければ、待っていた式を示して失敗する。進めた秒数を返す。
   * 時計を進めると描画が行われ、パッドが読まれ、シミュレーションが進むので、撃ち切る・残弾が減るなどを実時間で待たずに待てる。
   */
  async advanceClockUntil(expression: string, { step = 1 / 120, limit = 30 }: { step?: number; limit?: number } = {}): Promise<number> {
    const advanced = await this.evaluate<number>(`(() => {
      const clock = window.__apexTestClock;
      if (!clock) throw new Error('clock=manual で開いたページではない');
      let t = 0;
      while (!(${expression})) { if (t >= ${limit}) return -1; clock.advance(${step}, ${step}); t += ${step}; }
      return t; })()`);
    if (advanced < 0) throw new Error(`ページの時計を ${limit} 秒進めても次の状態にならない: ${expression}`);
    return advanced;
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

  /**
   * CSS セレクタに当たる最初の要素の中心をクリックする。
   * 読み込みの途中で上の要素（トップ画面の武器のカードなど）が埋まると要素がずれ、測った座標で別の要素を押してしまう。
   * フォントの読み込みを待ち、1 描画おいても位置が変わらず、その座標でいちばん上にある要素がこの要素（かその中）になるまで待ってから押す。
   */
  async clickSelector(selector: string, timeout = 10_000): Promise<void> {
    const box = await waitUntil(
      () =>
        this.evaluate<{ x: number; y: number } | null>(`(async () => {
          const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
          await document.fonts.ready;
          const measure = () => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
          const before = measure();
          // 裏のタブでは requestAnimationFrame が来ないので、来なければ 100 ms で測り直す。
          await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 100); });
          const after = measure();
          if (before.x !== after.x || before.y !== after.y) return null;
          const hit = document.elementFromPoint(after.x, after.y);
          return hit && (hit === el || el.contains(hit)) ? after : null; })()`),
      `要素 ${selector} が動かずに、その中心でいちばん上にある`,
      { timeout },
    );
    await this.click(box.x, box.y);
  }
}

export interface Browser {
  /** このブラウザで新しいタブを開く。テストごとに開き、ブラウザは起動し直さない（ARC-26）。 */
  newPage(): Promise<Page>;
  /** これまでに開いたタブをすべて閉じる。テストが終わるたびに呼び、裏で描画し続けるタブを残さない。 */
  closePages(): Promise<void>;
  close(): Promise<void>;
}

/**
 * ヘッドレスの Chromium を起動する。DevTools のポートは Chromium に空いているものを選ばせ（--remote-debugging-port=0）、
 * プロファイルの DevToolsActivePort から読む（ARC-18, ARC-19）。
 * プロファイルと Chromium の一時ディレクトリ（TMPDIR）は、起動ごとに作る 1 つの一時ディレクトリの下に分けて置き、
 * 閉じるときにまとめて消す。並行に流すほかのファイルの Chromium と取り合わず、終わったあとに残さない（ARC-34）。
 */
export async function launchBrowser(executable: string): Promise<Browser> {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-chromium-'));
  const profile = join(root, 'profile');
  const temp = join(root, 'tmp');
  mkdirSync(profile);
  mkdirSync(temp);
  // Chromium の子のプロセスが終わり際に書いたファイルで、消す途中に ENOTEMPTY になることがあるので何度か消し直す。
  const removeRoot = () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const child: ChildProcess = spawn(
    executable,
    [
      '--headless=new',
      // Linux の CI の runner（Ubuntu）は、権限のない利用者の名前空間を制限していて Chromium のサンドボックスが起動しない。
      // 開くのはテストが立てた手元のサーバーのページだけなので、Linux ではサンドボックスを使わない。
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      // 重いマシン（CI の runner や並行に流しているとき）では、ソフトウェアの WebGL の描画が遅いのを GPU のプロセスが固まったと
      // 見なして止められ、ブラウザ全体が応答しなくなる。GPU の監視を止める。
      '--disable-gpu-watchdog',
      '--window-size=1280,800',
      // 重いマシンでも描画やタイマーを間引かせない（画面が隠れている・裏にあると見なされて止まらないように）。
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      'about:blank',
    ],
    // 子のプロセス（GPU・描画・ネットワークなど）ごと止められるよう、Chromium を新しいプロセスグループで起動する。
    { stdio: 'ignore', detached: true, env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp } },
  );
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  /**
   * Chromium のプロセスグループに属するプロセスをすべて止め、いなくなるまで待つ。
   * 本体だけを止めると、残った子のプロセス（Linux の --no-sandbox ではとくに）がプロファイルに書き続け、
   * 消す途中に ENOTEMPTY になる。
   */
  const stop = async () => {
    const group = -child.pid!;
    /** グループにシグナルを送る。グループにもうプロセスがなければ（ESRCH）false。0 は送らずに確かめるだけ。 */
    const signal = (sig: NodeJS.Signals | 0) => {
      try {
        process.kill(group, sig);
        return true;
      } catch {
        return false;
      }
    };
    const gone = (what: string) => waitUntil(() => !signal(0), what, { timeout: 5_000, interval: 50 });
    signal('SIGTERM');
    await gone('Chromium と子のプロセスが終わる').catch(async () => {
      signal('SIGKILL');
      await gone('Chromium と子のプロセスが SIGKILL で終わる');
    });
    await exited;
  };
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
    await stop();
    removeRoot();
    throw error;
  }
  const opened: { id: string; socket: WebSocket }[] = [];
  return {
    async newPage() {
      const res = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' });
      const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((ok, ng) => {
        socket.addEventListener('open', () => ok());
        socket.addEventListener('error', () => ng(new Error('DevTools に接続できない')));
      });
      opened.push({ id: target.id, socket });
      const page = new Page(socket);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      await page.send('Page.bringToFront');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      return page;
    },
    async closePages() {
      for (const { id, socket } of opened.splice(0)) {
        socket.close();
        await fetch(`${endpoint}/json/close/${id}`).catch(() => undefined);
      }
    },
    async close() {
      for (const { socket } of opened.splice(0)) socket.close();
      // 子のプロセスまで終わったことを確かめてからプロファイルを消す（決まった時間は待たない）。
      await stop();
      removeRoot();
    },
  };
}
