// 継続的インテグレーション（docs/spec/architecture.md「継続的インテグレーション（CI）」、ARC-57〜ARC-62・ARC-97-1〜ARC-97-5）の確認。
// GitHub の上での実行は手元で再現できないので、ワークフローの設定（.github/workflows/ci.yml）・CLAUDE.md と、
// Chromium が見つからないときのブラウザを使うテストの振る舞い（入れ子に流す Vitest）を確かめる。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import config, { BROWSER_PROJECT, browserTestFiles, countBrowserTests, noBrowserTestsRan, REQUIRE_BROWSER_TESTS_ENV, requireBrowserTestsRan } from '../../vite.config';
import { REQUIRE_CHROMIUM_ENV } from '../helpers/chromium';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const WORKFLOW = '.github/workflows/ci.yml';
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  /** ステップの設定の行（字下げを除く）。 */
  lines: string[];
}

/** ワークフローの steps: の下の各ステップ（「- 」で始まる行ごとに区切る）。 */
function workflowSteps(text: string): Step[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
  if (start < 0) return [];
  const indent = /^(\s*)/.exec(lines[start + 1] ?? '')![1]!.length;
  const steps: Step[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const depth = /^(\s*)/.exec(line)![1]!.length;
    if (depth < indent) break;
    if (depth === indent && line.trimStart().startsWith('- ')) steps.push({ lines: [] });
    const step = steps.at(-1);
    if (!step) continue;
    const body = line.trim().replace(/^- /, '');
    step.lines.push(body);
    const m = /^(name|uses|run):\s*(.*)$/.exec(body);
    if (m && depth <= indent + 2) step[m[1] as 'name' | 'uses' | 'run'] = m[2]!.trim();
  }
  return steps;
}

describe('ワークフローの読み方', () => {
  it('調べ方: steps の各ステップの name・uses・run と、ステップの設定の行を読む', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          fetch-depth: 0',
      '      # コメント',
      '      - name: x',
      '        run: npm ci',
      '        env:',
      "          A: '1'",
      'other: 1',
    ].join('\n');
    const steps = workflowSteps(text);
    expect(steps.map((s) => [s.uses, s.name, s.run])).toEqual([
      ['actions/checkout@v4', undefined, undefined],
      [undefined, 'x', 'npm ci'],
    ]);
    expect(steps[1]!.lines).toContain("A: '1'");
  });
});

/** ワークフローの jobs: の下の各ジョブの設定の文字列（ジョブ名ごと）。 */
function workflowJobs(text: string): Record<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) jobs[m[1]!] = current = [];
    else current?.push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([name, body]) => [name, body.join('\n')]));
}

/** ジョブの設定の、字下げを除いた 1 行の値（key: value の value）。なければ undefined。 */
function jobValue(job: string, key: string): string | undefined {
  return new RegExp(`^ {4}${key}:\\s*(.*)$`, 'm').exec(job)?.[1]?.trim();
}

describe('ワークフローのジョブの読み方', () => {
  it('調べ方: jobs の下のジョブごとに設定を分け、ジョブの直下の値を読む', () => {
    const text = ['jobs:', '  a:', '    runs-on: x', '    steps:', '      - run: npm ci', '  b-c:', '    needs: [a]', 'other: 1'].join('\n');
    const jobs = workflowJobs(text);
    expect(Object.keys(jobs)).toEqual(['a', 'b-c']);
    expect(jobValue(jobs.a!, 'runs-on')).toBe('x');
    expect(workflowSteps(jobs.a!).map((s) => s.run)).toEqual(['npm ci']);
    expect(jobValue(jobs['b-c']!, 'needs')).toBe('[a]');
    expect(jobValue(jobs['b-c']!, 'runs-on')).toBeUndefined();
  });
});

/** Chromium を導入する run か。 */
const installsChromium = (run: string) => /playwright@[\w.${}\s]+ install\b.*\bchromium\b/.test(run);
/** ブラウザのテストの組の run。 */
const BROWSER_RUN = 'npm run test:browser -- --shard=${{ matrix.shard }}/4';

describe('CI のワークフロー', () => {
  const text = existsSync(join(ROOT, WORKFLOW)) ? read(WORKFLOW) : '';
  const jobs = workflowJobs(text);
  const check = jobs.check ?? '';
  const browser = jobs.browser ?? '';
  const summary = jobs.summary ?? '';
  const runsOf = (job: string) => workflowSteps(job).flatMap((s) => (s.run ? [installsChromium(s.run) ? 'Chromium の導入' : s.run] : []));

  it(`ARC-57: ${WORKFLOW} が 1 つだけあり、PR（作成・更新）と main への push で走る`, () => {
    expect(text, `${WORKFLOW} がない`).not.toBe('');
    const workflows = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '.github/workflows'], { cwd: ROOT, encoding: 'utf8' });
    expect(workflows.stdout.split('\n').filter(Boolean)).toEqual([WORKFLOW]);
    expect(text).toMatch(/^on:\s*\n\s+pull_request:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]\s*$/m);
  });

  it('ARC-57: ジョブは検査・ブラウザのテスト・まとめの 3 つで、どれも ubuntu-latest で動く', () => {
    expect(Object.keys(jobs)).toEqual(['check', 'browser', 'summary']);
    for (const [name, job] of Object.entries(jobs)) expect(jobValue(job, 'runs-on'), name).toBe('ubuntu-latest');
  });

  it('ARC-57: 検査のジョブは npm ci・lint・単体のテスト・ビルド・検査をこの順に流し、Chromium を入れない', () => {
    expect(runsOf(check)).toEqual(['npm ci', 'npm run lint', 'npm run test:unit', 'npm run build', 'npm run check:subpath', 'npm run check:assets']);
  });

  it('ARC-57・ARC-97-5: ブラウザのテストのジョブは npm ci・Chromium の導入・その組の test:browser をこの順に流す', () => {
    expect(runsOf(browser)).toEqual(['npm ci', 'Chromium の導入', BROWSER_RUN]);
  });

  it('ARC-57: Node.js は CLAUDE.md の版（22 系）を npm のキャッシュ付きで使い、Chromium はブラウザのテストが探すキャッシュに置いてキャッシュする', () => {
    expect(read('CLAUDE.md')).toMatch(/Node\.js 22\.12 以上/);
    for (const job of [check, browser]) {
      const steps = workflowSteps(job);
      const node = steps.find((s) => s.uses?.startsWith('actions/setup-node@'));
      expect(node?.lines).toContain('node-version: 22');
      expect(node?.lines).toContain('cache: npm');
      expect(steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'))).toBe(0);
    }
    const steps = workflowSteps(browser);
    const cache = steps.find((s) => s.uses?.startsWith('actions/cache@'));
    expect(cache?.lines).toContain('path: ~/.cache/ms-playwright');
    expect(read('tests/helpers/chromium.ts')).toContain("'.cache/ms-playwright'");
    expect(steps.indexOf(cache!)).toBeLessThan(steps.findIndex((s) => s.run !== undefined && installsChromium(s.run)));
    expect(workflowSteps(check).some((s) => s.uses?.startsWith('actions/cache@') || (s.run !== undefined && installsChromium(s.run)))).toBe(false);
  });

  it('ARC-97-5: ブラウザのテストのジョブは 4 つの組の matrix で、Chromium のキャッシュを Playwright の版ごとのキーで使い、検査のジョブを待たない', () => {
    expect(browser).toMatch(/^ {4}strategy:\s*\n(?:\s+#.*\n)* {6}fail-fast:\s*false\s*\n {6}matrix:\s*\n {8}shard:\s*\[1, 2, 3, 4\]\s*$/m);
    expect(jobValue(browser, 'needs')).toBeUndefined();
    expect(jobValue(browser, 'if')).toBeUndefined();
    const cache = workflowSteps(browser).find((s) => s.uses?.startsWith('actions/cache@'));
    expect(cache?.lines).toContain('key: ms-playwright-${{ runner.os }}-${{ env.PLAYWRIGHT_VERSION }}');
    expect(text).toMatch(/^env:\s*\n(?:\s+#.*\n)*\s+PLAYWRIGHT_VERSION:\s*\d+\.\d+\.\d+\s*$/m);
  });

  it('ARC-60・ARC-97-3・ARC-97-5: 組のブラウザのテストの段で APEX_REQUIRE_CHROMIUM を 1 に、APEX_BROWSER_WORKERS を 2 にする', () => {
    const step = workflowSteps(browser).find((s) => s.run === BROWSER_RUN);
    expect(step?.lines).toContain("APEX_REQUIRE_CHROMIUM: '1'");
    expect(step?.lines).toContain("APEX_BROWSER_WORKERS: '2'");
  });

  it('ARC-97-1: 1 つの組が失敗しても、ほかの組を取り消さない（fail-fast: false）', () => {
    expect(browser).toMatch(/^ {6}fail-fast:\s*false\s*$/m);
  });

  it('ARC-97-4: まとめのジョブは検査と 4 つの組をすべて待ち、失敗・取り消しのあとも走って、結果を scripts/ci-summary.mjs で決める', () => {
    expect(jobValue(summary, 'needs')).toBe('[check, browser]');
    expect(jobValue(summary, 'if')).toBe('always()');
    const step = workflowSteps(summary).find((s) => s.run !== undefined);
    expect(step?.run).toBe('node scripts/ci-summary.mjs check browser');
    expect(step?.lines).toContain('NEEDS: ${{ toJSON(needs) }}');
  });

  it('ARC-58: どのステップも失敗を飛ばさない（continue-on-error・|| true・ステップの if がない）', () => {
    expect(text).not.toMatch(/continue-on-error/);
    const runs = Object.values(jobs).flatMap((job) => workflowSteps(job).flatMap((s) => (s.run ? [s.run] : [])));
    expect(runs.filter((r) => /\|\||;|&&/.test(r))).toEqual([]);
    // 走る条件はまとめのジョブの always() だけ。
    expect([...text.matchAll(/^(\s+)if:\s*(.*)$/gm)].map((m) => [m[1]!.length, m[2]])).toEqual([[4, 'always()']]);
  });

  it('ARC-59: 同じブランチ（同じ PR）の新しい push で、走っている古い実行を取り消す', () => {
    expect(text).toMatch(/^concurrency:\s*\n\s+group:\s*.*github\.event\.pull_request\.number \|\| github\.ref.*\n\s+cancel-in-progress:\s*true\s*$/m);
  });

  it('ARC-61: runner は ubuntu-latest だけで、gh-pages への push や GitHub Pages への公開の手順がない', () => {
    expect(text).not.toMatch(/macos|windows|self-hosted/i);
    expect([...new Set([...text.matchAll(/runs-on:\s*(\S+)/g)].map((m) => m[1]))]).toEqual(['ubuntu-latest']);
    expect(text).not.toMatch(/gh-pages|deploy|pages: write|actions\/(deploy|upload)-pages|configure-pages|git push/i);
    expect(text).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
  });
});

describe('ARC-97-4: まとめのジョブの結果（scripts/ci-summary.mjs）', () => {
  const summarize = (needs: string | undefined, args = ['check', 'browser']) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NEEDS;
    if (needs !== undefined) env.NEEDS = needs;
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-summary.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
  };
  const needs = (check: string, browser: string) => JSON.stringify({ check: { result: check, outputs: {} }, browser: { result: browser, outputs: {} } });

  it('待ったジョブがすべて成功したときだけ成功する', () => {
    const r = summarize(needs('success', 'success'));
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/check: success/);
    expect(r.output).toMatch(/browser: success/);
  });

  it.each([
    ['failure', 'success'],
    ['success', 'failure'],
    ['cancelled', 'success'],
    ['success', 'cancelled'],
    ['skipped', 'success'],
  ])('検査が %s・ブラウザのテストが %s なら失敗し、成功していないジョブを示す', (c, b) => {
    const r = summarize(needs(c, b));
    expect(r.status, r.output).toBe(1);
    expect(r.output).toMatch(/成功していないジョブ: /);
    expect(r.output).toContain(c === 'success' ? `browser（${b}）` : `check（${c}）`);
  });

  it('待つジョブの結果がない・NEEDS を読めない・待つジョブの名前がないときは失敗する', () => {
    expect(summarize(JSON.stringify({ check: { result: 'success' } })).status).toBe(1);
    expect(summarize(undefined).status).toBe(1);
    expect(summarize('not json').status).toBe(1);
    expect(summarize('[]').status).toBe(1);
    expect(summarize(needs('success', 'success'), []).status).toBe(1);
  });
});

describe('ARC-97-2: ブラウザを使うテストのファイルの 4 つの組', () => {
  it('4 つの組に入るファイルを合わせると、ブラウザを使うテストのどのファイルもちょうど 1 つの組に入り、どの組にもファイルがある', () => {
    const shards = [1, 2, 3, 4].map((i) => {
      const out = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json', '--project', 'browser', `--shard=${i}/4`], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      expect(out.status, out.stdout + out.stderr).toBe(0);
      return (JSON.parse(out.stdout) as { file: string }[]).map((x) => relative(ROOT, x.file).split('\\').join('/'));
    });
    for (const files of shards) expect(files.length).toBeGreaterThan(0);
    const all = shards.flat();
    expect(new Set(all).size, '2 つの組に入るファイルがある').toBe(all.length);
    expect(all.sort()).toEqual(browserTestFiles(ROOT));
  }, 120_000);
});

describe('ARC-97-3: 流れたブラウザを使うテストが 1 件もない組を失敗にする', () => {
  /** countBrowserTests に渡す、終わったテストのファイルの見本。 */
  const module = (project: string, states: string[]) =>
    ({
      project: { name: project },
      children: { allTests: () => states.map((state) => ({ result: () => ({ state }) }))[Symbol.iterator]() },
    }) as unknown as Parameters<typeof countBrowserTests>[0][number];

  it('ブラウザを使うテストの組のファイルだけから、流れた（通った・落ちた）テストと飛ばされたテストを数える', () => {
    expect(countBrowserTests([])).toEqual({ ran: 0, skipped: 0 });
    expect(
      countBrowserTests([module(BROWSER_PROJECT, ['passed', 'failed', 'skipped', 'pending']), module('unit', ['passed', 'passed']), module(BROWSER_PROJECT, ['skipped'])]),
    ).toEqual({ ran: 2, skipped: 3 });
  });

  it('APEX_REQUIRE_CHROMIUM=1 のとき、流れたテストが 0 件なら理由を返し、1 件でもあれば失敗にしない', () => {
    const env = { [REQUIRE_BROWSER_TESTS_ENV]: '1' };
    expect(noBrowserTestsRan(env, { ran: 0, skipped: 0 })).toMatch(/APEX_REQUIRE_CHROMIUM=1 なのに、流れたブラウザを使うテストが 1 件もない（飛ばされたテスト: 0 件）/);
    expect(noBrowserTestsRan(env, { ran: 0, skipped: 5 })).toMatch(/飛ばされたテスト: 5 件/);
    expect(noBrowserTestsRan(env, { ran: 1, skipped: 5 })).toBeUndefined();
  });

  it('APEX_REQUIRE_CHROMIUM が 1 でなければ（手元の既定）、流れたテストが 0 件でも失敗にしない', () => {
    expect(noBrowserTestsRan({}, { ran: 0, skipped: 3 })).toBeUndefined();
    expect(noBrowserTestsRan({ [REQUIRE_BROWSER_TESTS_ENV]: '0' }, { ran: 0, skipped: 3 })).toBeUndefined();
  });

  it('環境変数は Chromium を必須にするものと同じで、確かめるプラグインはブラウザを使うテストの組にだけ入っている', () => {
    expect(REQUIRE_BROWSER_TESTS_ENV).toBe(REQUIRE_CHROMIUM_ENV);
    const projects = (config.test?.projects ?? []) as { plugins?: { name?: string }[]; test?: { name?: string } }[];
    const withPlugin = projects.filter((p) => (p.plugins ?? []).some((x) => x.name === requireBrowserTestsRan().name)).map((p) => p.test?.name);
    expect(withPlugin).toEqual([BROWSER_PROJECT]);
  });
});

describe.skipIf(NESTED)('ARC-60: Chromium が見つからないときのブラウザを使うテスト', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** Chromium の見つからない環境（HOME を空の一時ディレクトリにし、CHROMIUM_PATH をない場所にする）で、ブラウザを使うテストを 1 ファイル流す。 */
  function runWithoutChromium(require: boolean) {
    const home = mkdtempSync(join(tmpdir(), 'arc47-'));
    dirs.push(home);
    const file = browserTestFiles(ROOT).find((f) => f === 'tests/ui/analytics-browser.test.ts');
    expect(file).toBeDefined();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CHROMIUM_PATH: join(home, 'no-chromium'), CI: '1', FORCE_COLOR: '0' };
    delete env.APEX_REQUIRE_CHROMIUM;
    if (require) env.APEX_REQUIRE_CHROMIUM = '1';
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--project', 'browser', file!], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
  }

  it('APEX_REQUIRE_CHROMIUM がなければ、ブラウザを使うテストは飛ばされて成功になる（対照）', () => {
    const r = runWithoutChromium(false);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/skipped/);
  }, 120_000);

  it('APEX_REQUIRE_CHROMIUM=1 なら、飛ばされて成功になるのではなく失敗になり、見つからないことが出力に出る', () => {
    const r = runWithoutChromium(true);
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/APEX_REQUIRE_CHROMIUM=1 なのに Chromium が見つからない/);
  }, 120_000);
});

describe('ARC-62: CLAUDE.md の CI と GitHub Actions の記述', () => {
  // リポジトリの一部だけを写して流すテストもあるので、ファイルは集めるときでなくテストの中で読む。
  const claude = () => read('CLAUDE.md');

  it('CI があること（走るきっかけと実行する内容）と、Actions が有効で標準の Linux の runner だけを使うことが書いてある', () => {
    const text = claude();
    expect(text).toContain(WORKFLOW);
    expect(text).toMatch(/PR/);
    expect(text).toMatch(/`main` に push/);
    for (const command of ['npm ci', 'npm run lint', 'npm run test:unit', 'npm run test:browser', 'npm run build', 'npm run check:subpath', 'npm run check:assets']) {
      expect(text).toContain(command);
    }
    expect(text).toMatch(/GitHub Actions は有効/);
    expect(text).toMatch(/ubuntu-latest/);
    expect(text).toMatch(/標準の Linux の runner だけ/);
  });

  it('Actions を止めている・ワークフローを足しても動かない、という記述がない', () => {
    expect(claude()).not.toMatch(/Actions は費用のため止めている|止めている（2026-11-25）|ワークフローを足しても動かない/);
  });
});
