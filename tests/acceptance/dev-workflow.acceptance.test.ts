// docs/spec/architecture.md の受け入れ条件（ARC-13・ARC-14）の受け入れテスト。
// 新しく clone した作業ツリーでコマンドを実行し、ビルドの結果をサブパスで配信して確かめるため時間がかかる。
// ARC-13 の clone の中で npm test を実行したときに自分自身を入れ子で実行しないよう、
// 環境変数 APEX_ACCEPTANCE_NESTED が立っているときは飛ばす。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listenOnFreePort, originOf } from '../helpers/server';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function run(command: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** CLAUDE.md の技術スタックの表から、目的ごとのコマンドを読む。 */
function commandsFromClaudeMd(dir: string): Record<string, string> {
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  const commands: Record<string, string> = {};
  for (const m of text.matchAll(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/gm)) commands[m[1]!] = m[2]!;
  return commands;
}

describe.skipIf(NESTED)('ARC-13: 新しく clone した作業ツリーで CLAUDE.md のコマンドがすべて成功する', () => {
  it('セットアップ・テスト・ビルドのコマンドをそのとおりに実行すると成功する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc13-'));
    temps.push(dir);
    const clone = run(`git clone --quiet "${ROOT}" repo`, dir);
    expect(clone.status, clone.output).toBe(0);
    const repo = join(dir, 'repo');

    const commands = commandsFromClaudeMd(repo);
    const setup = commands['セットアップ'];
    const test = commands['単体テスト'] ?? commands['テスト'];
    const build = commands['ビルド'];
    expect(setup, 'CLAUDE.md にセットアップのコマンドがない').toBeDefined();
    expect(test, 'CLAUDE.md にテストのコマンドがない').toBeDefined();
    expect(build, 'CLAUDE.md にビルドのコマンドがない').toBeDefined();

    for (const command of [setup!, test!, build!]) {
      const result = run(command, repo, { APEX_ACCEPTANCE_NESTED: '1', CI: '1' });
      expect(result.status, `${command} が失敗した:\n${result.output.slice(-4000)}`).toBe(0);
    }
    expect(existsSync(join(repo, 'dist/index.html'))).toBe(true);
  }, 600_000);
});

describe.skipIf(NESTED)('ARC-14: ビルドの結果を /apex-training/ のサブパスで配信すると 404 にならない', () => {
  const BASE = '/apex-training/';
  let server: Server | undefined;
  afterAll(() => server?.close());

  it('トップと、読み込まれるスクリプト・スタイル・データがすべて読み込める', async () => {
    const out = mkdtempSync(join(tmpdir(), 'arc14-'));
    temps.push(out);
    const build = run(`npm run build -- --outDir "${out}" --emptyOutDir`, ROOT);
    expect(build.status, build.output).toBe(0);

    // dist をサブパスの下にだけ置く静的なサーバー（ほかのパスは 404）。
    server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      if (!path.startsWith(BASE)) return void res.writeHead(404).end();
      let file = normalize(join(out, path.slice(BASE.length)));
      if (!file.startsWith(out)) return void res.writeHead(404).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) return void res.writeHead(404).end();
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    // ポートは OS に選ばせる（ARC-18）。
    await listenOnFreePort(server);
    const origin = originOf(server);

    const statuses: Record<string, number> = {};
    const get = async (url: URL) => {
      const response = await fetch(url);
      statuses[url.pathname] = response.status;
      return response.ok ? response.text() : '';
    };

    const top = new URL(BASE, origin);
    const html = await get(top);
    expect(statuses[BASE]).toBe(200);

    const refs = [...html.matchAll(/<(script|link)\b[^>]*?(?:src|href)="([^"]+)"[^>]*>/g)]
      .map((m) => m[2]!)
      .filter((ref) => !/^(https?:)?\/\//.test(ref) && !ref.startsWith('data:'));
    const scripts: { url: URL; body: string }[] = [];
    for (const ref of refs) {
      const url = new URL(ref, top);
      const body = await get(url);
      if (url.pathname.endsWith('.js')) scripts.push({ url, body });
    }
    expect(Object.keys(statuses).some((p) => p.endsWith('.js')), 'スクリプトがない').toBe(true);
    expect(Object.keys(statuses).some((p) => p.endsWith('.css')), 'スタイルがない').toBe(true);

    // スクリプトが読み込む JS の chunk・CSS・データ（JSON）を拾って取得する。
    const seen = new Set<string>();
    while (scripts.length > 0) {
      const { url: base, body } = scripts.pop()!;
      // データの URL はベースパスから始まる文字列だけを拾う（import.meta.glob の "./range.json" のようなキーは URL ではない）。
      const pattern = /["'`]((?:\/apex-training\/|assets\/)[^"'`\s]+\.(?:js|css|json)|\.{1,2}\/[^"'`\s]+\.(?:js|css))["'`]/g;
      for (const m of body.matchAll(pattern)) {
        const ref = m[1]!;
        // 絶対パスはオリジン基準、./ や ../ は読み込んだスクリプト基準、それ以外（assets/…）はベースパス基準。
        const url = new URL(ref, ref.startsWith('/') ? origin : ref.startsWith('.') ? base : top);
        if (seen.has(url.pathname)) continue;
        seen.add(url.pathname);
        const text = await get(url);
        if (url.pathname.endsWith('.js')) scripts.push({ url, body: text });
      }
    }
    expect(Object.keys(statuses).some((p) => p.endsWith('.json')), 'データ（JSON）の読み込みが見つからない').toBe(true);

    const failures = Object.entries(statuses).filter(([, s]) => s !== 200);
    expect(failures, JSON.stringify(statuses, null, 2)).toEqual([]);
  }, 300_000);
});
