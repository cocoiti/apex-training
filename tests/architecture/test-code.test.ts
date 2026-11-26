// テストの実行（docs/spec/architecture.md「テストの実行」、ARC-18・ARC-21・ARC-22・ARC-32・ARC-33・ARC-35）の確認。
// このファイルは決まったポート番号や sleep の書き方を例として持つので、ARC-18 の確認の対象から外す。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { BROWSER_WORKERS_ENV, browserTestFiles, browserWorkers, DEFAULT_BROWSER_WORKERS, listTestFiles, usesChromium } from '../../vite.config';
import { listenOnFreePort, originOf, portOf } from '../helpers/server';
import { codeOnly, findFixedPorts, findFixedSleeps } from '../helpers/test-code';
import { waitUntil } from '../helpers/wait';

const ROOT = resolve(__dirname, '../..');
const SELF = relative(ROOT, __filename).split('\\').join('/');
/** ブラウザの道具のモジュールの指定（このファイル自身がブラウザを使うテストと見なされないよう、組み立てて作る）。 */
const BROWSER_HELPER = ['..', 'helpers', 'browser'].join('/');

/** tests/ 以下の TypeScript のファイル（テストと道具）。 */
function testCodeFiles(): string[] {
  const out = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'tests'], { cwd: ROOT, encoding: 'utf8' });
  return out.stdout.split('\n').filter((f) => f.endsWith('.ts'));
}

describe('ARC-18: テストは決まったポート番号で待ち受けない', () => {
  it('tests/ 以下のテストのコードに、サーバーの待ち受けやブラウザの遠隔操作へ決まったポート番号を渡している箇所がない', () => {
    const files = testCodeFiles().filter((f) => f !== SELF);
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((f) => findFixedPorts(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it.each([
    ['server.listen(3109, "127.0.0.1", ok)', 'listen'],
    ["createServer({ server: { port: 3108, strictPort: true } })", 'port'],
    ['const STATIC_PORT = 3106;', '定数'],
    ["'--remote-debugging-port=9222',", 'DevTools'],
    ['vite --port 3100', '--port'],
    ['await launchBrowser(chromium!, 3107);', 'launchBrowser'],
    ['await serveStatic(out, BASE, 3110);', 'serveStatic'],
    ['const origin = `http://127.0.0.1:3104`;', 'URL'],
  ])('決まったポート番号の書き方を見つける: %s', (line) => {
    expect(findFixedPorts('x.ts', `const a = 1;\n${line}\n`)).toMatchObject([{ file: 'x.ts', line: 2 }]);
  });

  it.each([
    'server.listen(0, "127.0.0.1", ok)',
    "createServer({ server: { port: 0, strictPort: true } })",
    "'--remote-debugging-port=0',",
    'await launchBrowser(chromium!);',
    'const origin = originOf(server);',
    'const port = portOf(server);',
    'const LIVE_URL = "https://cocoiti.github.io/apex-training/";',
  ])('ポート 0 や読んだ番号を使う書き方は見つけない: %s', (line) => {
    expect(findFixedPorts('x.ts', line)).toEqual([]);
  });

  it('listenOnFreePort は OS が選んだポートで待ち受け、そのポートの origin で応答する', async () => {
    const a = await listenOnFreePort(createServer((_, res) => res.end('a')));
    const b = await listenOnFreePort(createServer((_, res) => res.end('b')));
    try {
      expect(portOf(a)).toBeGreaterThan(0);
      expect(portOf(b)).not.toBe(portOf(a));
      expect(await (await fetch(originOf(a))).text()).toBe('a');
      expect(await (await fetch(originOf(b))).text()).toBe('b');
    } finally {
      await new Promise((ok) => a.close(ok));
      await new Promise((ok) => b.close(ok));
    }
  });
});

describe('ARC-21: ブラウザを使うテストとそれ以外を分けて流せる', () => {
  it('Chromium の道具を import するファイルだけを、ブラウザを使うテストと見なす', () => {
    expect(usesChromium(`import { findChromium } from '${BROWSER_HELPER}';`)).toBe(true);
    expect(usesChromium(`import { type Page } from "${BROWSER_HELPER}.ts";`)).toBe(true);
    expect(usesChromium(`import { listenOnFreePort } from '../helpers/server';`)).toBe(false);
    expect(usesChromium(`// tests/helpers/browser.ts を使わない`)).toBe(false);
  });

  it('文字列の中に見本として書いた呼び出しは、strings を付けた codeOnly で空白になり、実際の呼び出しは残る', () => {
    const sample = "const t = parse('x.ts', `beforeAll(async () => { b = await launchBrowser(e); });`);\nconst u = 'findChromium()';";
    expect(codeOnly(sample, { strings: true })).not.toMatch(/launchBrowser|findChromium/);
    expect(codeOnly(sample)).toMatch(/launchBrowser/);
    expect(codeOnly('browser = await launchBrowser(chromium!);', { strings: true })).toMatch(/launchBrowser\(/);
  });

  it('ブラウザを使うテストのファイルは、tests/ 以下のテストのファイルのうち、Chromium の道具を import するものちょうど', () => {
    const all = listTestFiles(ROOT);
    const browser = browserTestFiles(ROOT);
    expect(browser.length).toBeGreaterThan(0);
    for (const f of all.filter((x) => x !== SELF)) {
      // コメントや見本の表・文字列の中の名前ではなく、Chromium を探す・起動する関数を実際に呼んでいるか。
      const source = codeOnly(readFileSync(join(ROOT, f), 'utf8'), { strings: true });
      expect(browser.includes(f), f).toBe(/\b(?:findChromium|launchBrowser)\s*\(/.test(source));
    }
  });

  /** CLAUDE.md の技術スタックの表に書いた npm のコマンドで流れるファイル（vitest list で集める）。 */
  function filesOf(script: 'test' | 'test:unit' | 'test:browser'): string[] {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const command = scripts[script];
    expect(command, `package.json の ${script}`).toMatch(/^vitest run( --project \w+)?$/);
    const args = command!.replace(/^vitest run/, '').trim().split(/\s+/).filter(Boolean);
    const out = spawnSync('npx', ['vitest', 'list', '--filesOnly', '--json', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    expect(out.status, out.stdout + out.stderr).toBe(0);
    return (JSON.parse(out.stdout) as { file: string }[]).map((x) => relative(ROOT, x.file).split('\\').join('/')).sort();
  }

  it('CLAUDE.md に、ブラウザのテストだけを流すコマンドとそれ以外だけを流すコマンドが書いてある', () => {
    const text = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('`npm run test:browser`');
    expect(text).toContain('`npm run test:unit`');
  });

  it('test:browser では Chromium を使うファイルだけが、test:unit ではそれ以外だけが流れ、合わせると npm test のファイルと一致する', () => {
    const browser = filesOf('test:browser');
    const unit = filesOf('test:unit');
    const all = filesOf('test');
    const chromium = browserTestFiles(ROOT);
    expect(browser).toEqual(chromium);
    expect(unit.filter((f) => chromium.includes(f))).toEqual([]);
    expect([...browser, ...unit].sort()).toEqual(all);
    expect(all).toEqual(listTestFiles(ROOT));
  }, 120_000);
});

describe('ARC-32・ARC-33・ARC-35: ブラウザを使うテストのファイルを同時に流す数', () => {
  it('既定の数は 2〜4 で、環境変数がない・空のときは既定の数になる', () => {
    expect(DEFAULT_BROWSER_WORKERS).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_BROWSER_WORKERS).toBeLessThanOrEqual(4);
    expect(browserWorkers({})).toBe(DEFAULT_BROWSER_WORKERS);
    expect(browserWorkers({ [BROWSER_WORKERS_ENV]: '' })).toBe(DEFAULT_BROWSER_WORKERS);
  });

  it.each([['1', 1], ['2', 2], [' 4 ', 4], ['12', 12]])('APEX_BROWSER_WORKERS=%j なら %i', (value, n) => {
    expect(browserWorkers({ APEX_BROWSER_WORKERS: value })).toBe(n);
  });

  it.each(['0', 'abc', '-1', '1.5', '2x', '1e3', '99999999999999999999'])('APEX_BROWSER_WORKERS=%j は環境変数の名前を示して失敗する', (value) => {
    expect(() => browserWorkers({ APEX_BROWSER_WORKERS: value })).toThrow(/APEX_BROWSER_WORKERS/);
  });

  it('browser の組は、設定を読んだときの環境変数の数で並行に流し、unit の組とは順番の組（groupOrder）が違う', () => {
    const projects = (config as { test?: { projects?: { test?: { name?: string; maxWorkers?: unknown; fileParallelism?: unknown; sequence?: { groupOrder?: number } } }[] } })
      .test?.projects ?? [];
    const byName = new Map(projects.map((p) => [p.test?.name, p.test]));
    const browser = byName.get('browser');
    expect(browser?.maxWorkers).toBe(browserWorkers(process.env));
    expect(browser?.fileParallelism).toBeUndefined();
    expect(browser?.sequence?.groupOrder).not.toBe(byName.get('unit')?.sequence?.groupOrder);
  });

  it('CLAUDE.md のテストのコマンドに、既定の数と APEX_BROWSER_WORKERS での変え方（1 で 1 ファイルずつ）が書いてある', () => {
    const text = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(text).toContain(`既定で ${DEFAULT_BROWSER_WORKERS} ファイルずつ並行に流す`);
    expect(text).toContain('`APEX_BROWSER_WORKERS=1 npm run test:browser` で 1 ファイルずつ');
  });
});

describe('ARC-22: ブラウザを使うテストは決まった時間の sleep で画面の状態を待たない', () => {
  it('ブラウザを使うテストのコードに、固定の時間だけ待つ sleep がない', () => {
    const files = browserTestFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((f) => findFixedSleeps(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it.each([
    'const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));',
    'await new Promise((resolve) => setTimeout(resolve, 1500));',
    'await new Promise<void>((ok) => setTimeout(() => ok(), 300));',
    'await pause(300);',
    'await sleep(1000);',
    "import { setTimeout as wait } from 'node:timers/promises';",
  ])('決まった時間だけ待つ書き方を見つける: %s', (line) => {
    expect(findFixedSleeps('x.ts', line).length).toBeGreaterThan(0);
  });

  it.each([
    "await page.waitFor(`location.hash === '#/result'`, 10_000);",
    'await page.frames(2);',
    "setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 0);",
    'onLockChange: (locked) => { if (locked) loop.resume(); else loop.pause(); },',
    "await waitUntil(() => ready, '準備ができる');",
  ])('条件を確かめて待つ書き方は見つけない: %s', (line) => {
    expect(findFixedSleeps('x.ts', line)).toEqual([]);
  });

  it('コメントと it.each の見本の表に書いた書き方は、決まったポートや sleep と見なさない', () => {
    const source = [
      '// server.listen(3100) のような書き方を探す',
      "it.each(['await sleep(1000);', 'const PORT = 3100;'])('見本: %s', () => {});",
      'server.listen(3109);',
    ].join('\n');
    expect(findFixedPorts('x.ts', source)).toMatchObject([{ line: 3 }]);
    expect(findFixedSleeps('x.ts', source)).toEqual([]);
  });

  it('waitUntil は条件が真になったらその値を返し、上限を過ぎたら何を待っていたかを示して失敗する', async () => {
    let n = 0;
    expect(await waitUntil(() => (n += 1) >= 3 && n, '3 回目', { interval: 0 })).toBe(3);
    await expect(waitUntil(() => false, '来ない状態', { timeout: 30, interval: 5 })).rejects.toThrow(/来ない状態/);
  });
});
