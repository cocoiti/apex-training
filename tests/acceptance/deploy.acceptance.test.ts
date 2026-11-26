// docs/spec/overview.md「公開」の受け入れ条件（OVR-7・OVR-8・OVR-9）の受け入れテスト。
// 公開された入口（npm run deploy、公開された gh-pages ブランチの中身、公開先の画面）だけを使い、実装の内部には依存しない。
//
// OVR-7: 本物の GitHub へ push しないよう、リポジトリを一時ディレクトリへ clone し、origin を手元の bare リポジトリに付け替えて
//   npm run deploy を実行する。念のため github.com の URL も git の url.<base>.insteadOf でその bare リポジトリへ向ける。
// OVR-9: OVR-7 の 2 回の公開のあとで、作業ツリーに未コミットの変更を作ってもう一度 npm run deploy を実行し、断られることを確かめる。
// OVR-8: 公開先（https://cocoiti.github.io/apex-training/）を開く確認はネットワークと実際の公開が要るため、
//   APEX_ACCEPTANCE_LIVE=1 のときだけ実行する。いつもは代わりに、OVR-7 で push された gh-pages ブランチの中身を
//   GitHub Pages と同じ形（ブランチのルートを /apex-training/ で配信）で配信して開く。
// 画面の確認はヘッドレスの Chromium で行う（tests/helpers/browser.ts）。Chromium がなければ飛ばす。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら飛ばす。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, findChromium, launchBrowser, originOf, serveStatic, type Browser, type Page } from '../helpers/browser';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const LIVE = process.env.APEX_ACCEPTANCE_LIVE === '1';
const LIVE_URL = 'https://cocoiti.github.io/apex-training/';
const BASE = '/apex-training/';
/** ページを開く練習の乱数の種（docs/spec/architecture.md「テストのための乱数の種の固定」）。テストが失敗したときのメッセージにも出る。 */
const SEED = 12345;

const temps: string[] = [];

function sh(command: string, cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function git(args: string, cwd: string): string {
  const r = sh(`git ${args}`, cwd);
  if (r.status !== 0) throw new Error(`git ${args} が失敗した:\n${r.output}`);
  return r.stdout.trim();
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** dir の下のファイルの、相対パス（/ 区切り）から内容のハッシュへの対応。skip に当たる名前のディレクトリは見ない。 */
function tree(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const rel = relative(dir, path).split(sep).join('/');
      if (skip.includes(rel)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** bare リポジトリのブランチの中身を dir に取り出す。 */
function extractBranch(bare: string, branch: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const r = sh(`git --git-dir="${bare}" archive --format=tar "${branch}" | tar -x -C "${dir}"`, ROOT);
  if (r.status !== 0) throw new Error(`${branch} を取り出せない:\n${r.output}`);
}

/** 公開に関わる状態（ブランチ、origin の既定ブランチ、作業ツリーの内容、git status、worktree の一覧）。 */
function snapshot(clone: string, bare: string) {
  return {
    currentBranch: git('symbolic-ref HEAD', clone),
    head: git('rev-parse HEAD', clone),
    localMain: git('rev-parse refs/heads/main', clone),
    originMain: git(`--git-dir="${bare}" rev-parse refs/heads/main`, clone),
    originWork: git(`--git-dir="${bare}" rev-parse refs/heads/work`, clone),
    ghPages: sh(`git --git-dir="${bare}" rev-parse --verify -q refs/heads/gh-pages`, clone).stdout.trim(),
    status: git('status --porcelain=v1 --untracked-files=all', clone),
    files: tree(clone, ['.git', 'node_modules']),
    worktrees: git('worktree list --porcelain', clone),
  };
}

let ready = false;
let clone = '';
let bare = '';
let referenceDist: Record<string, string> = {};
const deploys: { name: string; status: number | null; output: string; before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot> }[] = [];
/** 2 回目の公開のあとの gh-pages ブランチの中身を取り出したディレクトリ（OVR-8 で配信する）。 */
let published = '';

function deploy(name: string) {
  const before = snapshot(clone, bare);
  // github.com への push が起きても手元の bare リポジトリへ向かうようにする（本物の公開先を守る）。
  const redirect = {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/cocoiti/apex-training',
    GIT_CONFIG_KEY_1: `url.${bare}.insteadOf`,
    GIT_CONFIG_VALUE_1: 'git@github.com:cocoiti/apex-training',
    GIT_CONFIG_KEY_2: `url.${bare}.pushInsteadOf`,
    GIT_CONFIG_VALUE_2: 'https://github.com/',
  };
  const r = sh('npm run deploy', clone, redirect);
  const after = snapshot(clone, bare);
  deploys.push({ name, status: r.status, output: r.output, before, after });
  return deploys.at(-1)!;
}

beforeAll(() => {
  if (NESTED) return;
  const work = tempDir('ovr7-');
  bare = join(work, 'origin.git');
  clone = join(work, 'clone');

  // 手元の origin（bare）と、そこから clone した作業用のリポジトリを作る。既定ブランチ main と作業中のブランチ work を持つ。
  git(`init --bare --initial-branch=main "${bare}"`, work);
  git(`clone --quiet "${ROOT}" "${clone}"`, work);
  git('checkout --quiet -B main', clone);
  git(`remote set-url origin "${bare}"`, clone);
  git('config user.name "Acceptance Test"', clone);
  git('config user.email "acceptance@example.invalid"', clone);
  git('push --quiet origin main', clone);
  git('checkout --quiet -b work', clone);
  // 既定ブランチと今のブランチが別のコミットを指すよう、作業中のブランチに 1 つコミットを足す（ビルドに関わらないファイル）。
  writeFileSync(join(clone, 'ACCEPTANCE_WORK.md'), 'work branch\n');
  git('add ACCEPTANCE_WORK.md', clone);
  git('commit --quiet -m "work"', clone);
  git('push --quiet origin work', clone);
  git('branch --quiet --set-upstream-to=origin/work', clone);

  // 依存は元のリポジトリのものを使う（ネットワークに出ない）。
  symlinkSync(join(ROOT, 'node_modules'), join(clone, 'node_modules'));
  writeFileSync(join(clone, '.git/info/exclude'), 'node_modules\n', { flag: 'a' });

  // 無視されたファイルだけがある作業ツリー（未コミットの変更はない）で公開する。手元の dist/ に古いビルドを置いておく。
  mkdirSync(join(clone, 'dist'), { recursive: true });
  writeFileSync(join(clone, 'dist/local-stale.html'), '<p>local</p>\n');

  // 比べるためのビルド結果（作業用のリポジトリの外へ出す）。
  const ref = tempDir('ovr7-ref-');
  const build = sh(`npm run build -- --outDir "${ref}" --emptyOutDir`, ROOT);
  if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.output}`);
  referenceDist = tree(ref);

  // 1 回目: origin に gh-pages ブランチがない状態で公開する。
  deploy('初回（gh-pages なし）');

  // 2 回目の前に、origin の gh-pages ブランチへ前回の公開の古いファイルを足しておく。
  if (deploys[0]!.status === 0 && sh(`git --git-dir="${bare}" rev-parse --verify -q refs/heads/gh-pages`, ROOT).status === 0) {
    const other = join(work, 'other');
    git(`clone --quiet --branch gh-pages "${bare}" "${other}"`, work);
    git('config user.name "Acceptance Test"', other);
    git('config user.email "acceptance@example.invalid"', other);
    mkdirSync(join(other, 'assets'), { recursive: true });
    writeFileSync(join(other, 'assets/stale-old.js'), 'console.log("old");\n');
    writeFileSync(join(other, 'stale.html'), '<p>old</p>\n');
    git('add -A', other);
    git('commit --quiet -m "stale"', other);
    git('push --quiet origin gh-pages', other);
  }

  // 2 回目: 古いファイルが gh-pages にある状態で公開する。
  deploy('2 回目（古いファイルあり）');

  if (sh(`git --git-dir="${bare}" rev-parse --verify -q refs/heads/gh-pages`, ROOT).status === 0) {
    published = join(work, 'published');
    extractBranch(bare, 'gh-pages', published);
  }

  // 3 回目（OVR-9）: 未コミットの変更（追跡しているファイルの変更、ステージした変更、追跡していないファイル）を作って公開する。
  writeFileSync(join(clone, 'README.md'), `${readFileSync(join(clone, 'README.md'), 'utf8')}\nuncommitted change\n`);
  writeFileSync(join(clone, 'ACCEPTANCE_STAGED.md'), 'staged\n');
  git('add ACCEPTANCE_STAGED.md', clone);
  writeFileSync(join(clone, 'ACCEPTANCE_UNTRACKED.md'), 'untracked\n');
  deploy('3 回目（未コミットの変更あり）');
  ready = true;
}, 900_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(NESTED)('OVR-7: npm run deploy で gh-pages ブランチへ公開する', () => {
  it('前提: 比べるためのビルド結果がある', () => {
    expect(ready).toBe(true);
    expect(Object.keys(referenceDist)).toContain('index.html');
  });

  it.each([0, 1])('公開 %i 回目: コマンドが 0 で終わる', (i) => {
    const d = deploys[i]!;
    expect(d.status, `${d.name}\n${d.output.slice(-4000)}`).toBe(0);
  });

  it.each([0, 1])('公開 %i 回目: origin の gh-pages ブランチのルートが、ビルド結果と空の .nojekyll だけになる', (i) => {
    // それぞれの公開のあとの gh-pages を、そのときの origin から見る（2 回目のあとは最新しか残らないので、1 回目は履歴から見る）。
    const commits = git(`--git-dir="${bare}" rev-list --first-parent refs/heads/gh-pages`, ROOT).split('\n');
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const dir = tempDir('ovr7-gh-');
    if (i === 1) {
      extractBranch(bare, 'gh-pages', dir);
    } else {
      // 1 回目の公開のコミット = 古いファイルを足したコミットの親（足していなければ最古）。
      const stale = git(`--git-dir="${bare}" log --format=%H --grep=^stale$ refs/heads/gh-pages`, ROOT);
      const first = stale ? git(`--git-dir="${bare}" rev-parse ${stale}^`, ROOT) : commits.at(-1)!;
      extractBranch(bare, first, dir);
    }
    const files = tree(dir);
    expect(files['.nojekyll'], '.nojekyll がない').toBeDefined();
    expect(statSync(join(dir, '.nojekyll')).size, '.nojekyll が空でない').toBe(0);
    const rest = { ...files };
    delete rest['.nojekyll'];
    expect(rest).toEqual(referenceDist);
  });

  it('2 回目の公開で、前回の公開にあってビルド結果にないファイル（stale.html、assets/stale-old.js）は残らない', () => {
    expect(published, 'gh-pages ブランチがない').not.toBe('');
    // 前提: 古いファイルを確かに足してから公開した。
    expect(git(`--git-dir="${bare}" log --format=%s refs/heads/gh-pages`, ROOT).split('\n')).toContain('stale');
    expect(existsSync(join(published, 'stale.html'))).toBe(false);
    expect(existsSync(join(published, 'assets/stale-old.js'))).toBe(false);
  });

  it.each([0, 1])('公開 %i 回目: 実行前後で、今のブランチ・既定ブランチ（手元と origin）・作業ツリーの内容・worktree の一覧が変わらない', (i) => {
    const { before, after, name } = deploys[i]!;
    expect(after.currentBranch, name).toBe('refs/heads/work');
    expect(after.currentBranch).toBe(before.currentBranch);
    expect(after.head, '今のブランチのコミットが変わった').toBe(before.head);
    expect(after.localMain, '手元の既定ブランチが変わった').toBe(before.localMain);
    expect(after.originMain, 'origin の既定ブランチが変わった').toBe(before.originMain);
    expect(after.originWork, 'origin の今のブランチが変わった').toBe(before.originWork);
    expect(after.status, 'git status が変わった').toBe(before.status);
    const outside = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith('dist/')));
    expect(outside(after.files), '作業ツリーのファイルの内容が変わった').toEqual(outside(before.files));
    expect(after.worktrees, '一時的な作業ツリーが片付いていない').toBe(before.worktrees);
  });

  it.each([0, 1])('公開 %i 回目: 実行前後で、作業ツリーの無視されたファイル（dist/）も変わらない（作業は一時的な作業ツリーで行う）', (i) => {
    const { before, after, name } = deploys[i]!;
    const dist = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith('dist/')));
    expect(dist(after.files), `${name}: 作業ツリーの dist/ が変わった`).toEqual(dist(before.files));
  });

});

describe.skipIf(NESTED)('OVR-9: 未コミットの変更があるときは公開しない', () => {
  it('前提: 未コミットの変更（変更・ステージ・追跡していないファイル）がある状態で実行した', () => {
    const { before } = deploys[2]!;
    expect(before.status).toContain(' M README.md');
    expect(before.status).toContain('A  ACCEPTANCE_STAGED.md');
    expect(before.status).toContain('?? ACCEPTANCE_UNTRACKED.md');
    expect(before.ghPages, '前提: OVR-7 の公開で gh-pages ブランチがある').not.toBe('');
  });

  it('未コミットの変更がある旨を示して 0 以外で終わる', () => {
    const d = deploys[2]!;
    expect(d.status, d.output.slice(-4000)).not.toBe(0);
    expect(d.output).toContain('未コミットの変更');
  });

  it('origin の gh-pages ブランチ、ブランチ、作業ツリーの内容（未コミットの変更を含む）、worktree の一覧が変わらない', () => {
    const { before, after } = deploys[2]!;
    expect(after).toEqual(before);
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toContain('uncommitted change');
  });
});

const chromium = findChromium();

/** #/settings を直接開き、設定画面が表示され、武器データ（JSON）の読み込みが 404 にならないことを確かめる。 */
async function expectSettingsWithWeapons(page: Page, url: string) {
  await page.goto(url);
  await page.waitFor(`document.querySelector('[data-screen="settings"]') && !document.querySelector('[data-screen="settings"]').hidden`, 20_000);
  // 武器データ（JSON）の読み込みが終わって選択肢に出るまで待つ。
  await page.waitFor(
    `document.querySelector('#weapon') && document.querySelector('#weapon').options.length > 0 && performance.getEntriesByType('resource').some((e) => new URL(e.name).pathname.endsWith('.json'))`,
    20_000,
  );
  const visible = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-screen]')].filter((el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return !el.hidden && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }).map((el) => el.dataset.screen)`);
  expect(visible).toEqual(['settings']);
  const resources = await page.evaluate<{ name: string; status: number }[]>(
    `performance.getEntriesByType('resource').map((e) => ({ name: e.name, status: e.responseStatus ?? 0 }))`,
  );
  const json = resources.filter((r) => new URL(r.name).pathname.endsWith('.json'));
  expect(json.length, `武器データ（JSON）の読み込みが見つからない: ${JSON.stringify(resources, null, 2)}`).toBeGreaterThan(0);
  // ブラウザが勝手に取りに行く /favicon.ico（サイトの外）は対象にしない。アプリが読み込むサブパスの下のものだけを見る。
  const failed = resources.filter((r) => new URL(r.name).pathname.startsWith(BASE) && r.status >= 400);
  expect(failed, JSON.stringify(resources, null, 2)).toEqual([]);
  for (const r of json) expect(new URL(r.name).pathname.startsWith(BASE), r.name).toBe(true);
  expect(page.errors).toEqual([]);
}

describe.skipIf(NESTED || !chromium)('OVR-8: 公開した #/settings を直接開く', () => {
  let browser: Browser | undefined;

  beforeAll(async () => {
    browser = await launchBrowser(chromium!);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe('公開した gh-pages ブランチの中身を、GitHub Pages と同じ形（ルートを /apex-training/）で配信する', () => {
    let server: Server | undefined;

    beforeAll(async () => {
      if (published) server = await serveStatic(published, BASE);
    });

    afterAll(async () => {
      await new Promise((ok) => (server ? server.close(ok) : ok(undefined)));
    });

    it('#/settings で設定画面が表示され、武器データの読み込みが 404 にならない', async () => {
      expect(published, 'gh-pages ブランチがない').not.toBe('');
      const page = await browser!.newPage();
      await expectSettingsWithWeapons(page, appUrl(originOf(server!), BASE, '#/settings', { seed: SEED }));
    }, 60_000);
  });

  describe.skipIf(!LIVE)(`公開先 ${LIVE_URL}（APEX_ACCEPTANCE_LIVE=1 のときだけ）`, () => {
    it('#/settings で設定画面が表示され、武器データの読み込みが 404 にならない', async () => {
      const page = await browser!.newPage();
      await expectSettingsWithWeapons(page, `${LIVE_URL}#/settings`);
    }, 60_000);
  });
});
