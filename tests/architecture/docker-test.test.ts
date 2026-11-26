// Docker でのブラウザのテスト（docs/spec/architecture.md「Docker でのブラウザのテスト」、ARC-72・ARC-73）の確認。
// イメージを作って流すこと（ARC-69〜ARC-71）は時間がかかり Docker も要るので、ここでは Dockerfile.test・.dockerignore・CLAUDE.md と、
// イメージの中で Chromium を見つける findChromium を確かめる。npm run test:remote の振る舞いは tests/scripts/test-remote.test.ts で確かめる。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// 偽の置き場所を探すだけで Chromium を起動しないので、ブラウザを使うテストの組（findChromium( を呼ぶファイル）に入れないよう別の名前で使う。
import { findChromium as findChromiumIn } from '../helpers/chromium';

const ROOT = resolve(__dirname, '../..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Dockerfile の命令の行（コメントと空行を除き、行の継続をつないだもの）。 */
function instructions(text: string): string[] {
  return text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

describe('ARC-72: Dockerfile.test と .dockerignore', () => {
  const lines = () => instructions(read('Dockerfile.test'));

  it('もとのイメージは Playwright の公式イメージで、版は CI が Chromium を入れる Playwright の版と同じ', () => {
    const from = lines().filter((l) => /^FROM\s/i.test(l));
    expect(from).toHaveLength(1);
    const m = /^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[a-z]+)?$/.exec(from[0]!);
    expect(m, from[0]).not.toBeNull();
    const ci = /^\s*PLAYWRIGHT_VERSION:\s*(\S+)\s*$/m.exec(read('.github/workflows/ci.yml'));
    expect(ci?.[1]).toBe(m![1]);
  });

  it('package.json と lockfile のコピーと npm ci が、ソース全体のコピーより前にある', () => {
    const l = lines();
    const copyDeps = l.findIndex((x) => /^COPY\s+package\.json\s+package-lock\.json\s+\S+$/.test(x));
    const install = l.findIndex((x) => /^RUN\s+npm ci\b/.test(x));
    const copyAll = l.findIndex((x) => /^COPY\s+\.\s+\S+$/.test(x));
    expect(copyDeps).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(copyDeps);
    expect(copyAll).toBeGreaterThan(install);
    // npm ci より前に、ソースを含むコピーがない（あれば src/ や tests/ を変えるたびに依存を入れ直す）。
    expect(l.slice(0, install).filter((x) => /^(COPY|ADD)\s/.test(x))).toEqual([l[copyDeps]]);
  });

  it('イメージの中では Chromium を公式イメージの場所から探し、見つからなければテストを飛ばさずに失敗にする', () => {
    const env = lines().filter((l) => /^ENV\s/.test(l)).join(' ');
    expect(env).toMatch(/\bPLAYWRIGHT_BROWSERS_PATH=\/ms-playwright\b/);
    expect(env).toMatch(/\bAPEX_REQUIRE_CHROMIUM=1\b/);
  });

  it('.dockerignore は node_modules・dist・.git を除く', () => {
    const ignored = read('.dockerignore')
      .split('\n')
      .map((l) => l.trim().replace(/^\/|\/$/g, ''))
      .filter((l) => l !== '' && !l.startsWith('#'));
    for (const name of ['node_modules', 'dist', '.git']) expect(ignored).toContain(name);
  });

  it('CI は npm run test:remote を使わず、runner の上で直接テストを流す', () => {
    expect(read('.github/workflows/ci.yml')).not.toMatch(/test:remote|Dockerfile\.test/);
  });
});

describe('ARC-73: CLAUDE.md の npm run test:remote の使い方', () => {
  it('Docker が要ること、TEST_DOCKER_CONTEXT と既定の macmini、手元の Docker で流れる場合、終了コードが書いてある', () => {
    const text = read('CLAUDE.md');
    expect(text).toContain('npm run test:remote');
    const section = text.slice(text.indexOf('npm run test:remote'));
    expect(section).toMatch(/Docker が要る/);
    expect(section).toContain('TEST_DOCKER_CONTEXT');
    expect(section).toMatch(/既定.{0,10}`macmini`/);
    expect(section).toMatch(/ない.{0,40}つながらない.{0,40}手元の Docker/);
    expect(section).toMatch(/終了コード.{0,40}コンテナの中/);
  });
});

describe('findChromium（イメージの中の Chromium の探し方）', () => {
  /** root の下に、Playwright のキャッシュに見立てて空の実行ファイルを置く。 */
  function place(root: string, file: string): string {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    return path;
  }
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'find-chromium-'));
    temps.push(dir);
    return dir;
  }

  it('PLAYWRIGHT_BROWSERS_PATH の下の Chromium（arm64 と amd64 の Linux）を、home のキャッシュより先に見つける', () => {
    const home = tempDir();
    place(home, '.cache/ms-playwright/chromium-1000/chrome-linux64/chrome');
    for (const dir of ['chrome-linux-arm64', 'chrome-linux64']) {
      const browsers = tempDir();
      const bin = place(browsers, `chromium-1254/${dir}/chrome`);
      expect(findChromiumIn({ PLAYWRIGHT_BROWSERS_PATH: browsers }, home)).toBe(bin);
    }
  });

  it('arm64 の Linux の chrome-headless-shell も見つける', () => {
    const browsers = tempDir();
    const bin = place(browsers, 'chromium_headless_shell-1254/chrome-headless-shell-linux-arm64/chrome-headless-shell');
    expect(findChromiumIn({ PLAYWRIGHT_BROWSERS_PATH: browsers }, tempDir())).toBe(bin);
  });

  it('PLAYWRIGHT_BROWSERS_PATH がなければ home のキャッシュから探し、どこにもなく APEX_REQUIRE_CHROMIUM=1 なら探した場所を示して失敗する', () => {
    const home = tempDir();
    expect(findChromiumIn({}, home)).toBeUndefined();
    const browsers = tempDir();
    expect(() => findChromiumIn({ PLAYWRIGHT_BROWSERS_PATH: browsers, APEX_REQUIRE_CHROMIUM: '1' }, home)).toThrow(browsers);
    const bin = place(home, '.cache/ms-playwright/chromium-1000/chrome-linux/chrome');
    expect(findChromiumIn({}, home)).toBe(bin);
  });
});
