// docs/spec/architecture.md「Docker でのブラウザのテスト」（#85）の受け入れ条件（ARC-69〜ARC-73）の受け入れテスト（QA）。
// 公開された入口（npm run test:remote と npm run test:browser のコマンドとその出力・終了コード、Dockerfile.test、.dockerignore、
// .github/workflows/ 以下の CI のワークフロー、CLAUDE.md）だけを使い、実装の内部には依存しない。
//
// - ARC-72・ARC-73: いつも流す。ファイルを読むだけなので速い。
// - ARC-69・ARC-70・ARC-71: Docker でイメージを作り、コンテナの中で npm run test:browser を 2 回流し、手元でも 1 回流すため
//   30 分ほどかかる。APEX_ACCEPTANCE_DOCKER=1 のときだけ流す（Docker が使えるマシンで）。
//   APEX_ACCEPTANCE_DOCKER=1 npx vitest run --project unit tests/acceptance/docker-remote-qa.acceptance.test.ts
//   作業ツリーを一時ディレクトリに写し（node_modules は symlink、.git・dist は写さない）、その写しで test:remote を流す。
//   1 回目（ARC-69）はそのまま、2 回目は tests/ にわざと失敗するブラウザのテストを足し、src/ のファイルも変えて流す（ARC-70・ARC-71）。
// このファイルはブラウザを使う組に入らない（tests/helpers/browser.ts を import しない）。
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const HEAVY = process.env.APEX_ACCEPTANCE_DOCKER === '1' && !NESTED;
const MISSING_CONTEXT = 'apex-qa-no-such-context-85';

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI, '');

/** 子のプロセスの環境。親の Vitest の環境変数は渡さない。 */
function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...extra })) {
    if (v === undefined) continue;
    if (k === 'VITEST' || k.startsWith('VITEST_') || k === 'TEST' || k === 'NODE_ENV') continue;
    env[k] = v;
  }
  return env;
}

interface Run { status: number | null; output: string }

/** コマンドを流し、標準出力と標準エラーをまとめて返す（長く走るので非同期）。 */
function run(command: string, cwd: string, env: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, env: childEnv(env) });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    child.on('close', (status) => done({ status, output: stripAnsi(output) }));
  });
}

const tail = (s: string, n = 6000) => (s.length > n ? s.slice(-n) : s);

// ---------------------------------------------------------------- Dockerfile.test の読み取り

interface Instruction { op: string; args: string }

/** Dockerfile の命令（行の継続をつなぎ、コメントを除く）。 */
function instructions(source: string): Instruction[] {
  const out: Instruction[] = [];
  let buf = '';
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (buf === '' && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      buf += `${line.slice(0, -1)} `;
      continue;
    }
    buf += line;
    const m = /^(\w+)\s+([\s\S]*)$/.exec(buf);
    if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]!.trim() });
    buf = '';
  }
  return out;
}

/** COPY の送り元（--from などの旗と最後の送り先を除く）。JSON の形にも対応する。 */
function copySources(args: string): string[] {
  const parts = args.startsWith('[')
    ? (JSON.parse(args) as string[])
    : args.split(/\s+/).filter((p) => !p.startsWith('--'));
  return parts.slice(0, -1);
}

/** CI のワークフローで Chromium を入れる Playwright の版。 */
function ciPlaywrightVersion(): string {
  const dir = join(ROOT, '.github/workflows');
  const versions = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(dir, name), 'utf8');
    const env = new Map<string, string>();
    for (const m of text.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*:\s*['"]?([^'"\s#]+)['"]?/gm)) env.set(m[1]!, m[2]!);
    for (const m of text.matchAll(/playwright@(\$\{\{[^}]*\}\}|\S+)\s+install\b[^\n]*chromium/g)) {
      let v = m[1]!;
      const ref = /^\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}$/.exec(v);
      if (ref) v = env.get(ref[1]!) ?? v;
      versions.add(v);
    }
  }
  expect(versions.size, 'CI のワークフローに Chromium を入れる playwright@<版> install がちょうど 1 つの版で書いてある').toBe(1);
  return [...versions][0]!;
}

// ---------------------------------------------------------------- vitest の出力の数

interface Summary { passed: number; failed: number; skipped: number; total: number }

/** vitest の既定の出力の「Tests  N passed | M failed (T)」の行（最後のもの）。 */
function testsSummary(output: string): Summary | undefined {
  const lines = output.split('\n').filter((l) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(l));
  const line = lines.at(-1);
  if (!line) return undefined;
  const num = (word: string) => Number(new RegExp(`(\\d+)\\s+${word}`).exec(line)?.[1] ?? 0);
  return {
    passed: num('passed'),
    failed: num('failed'),
    skipped: num('skipped') + num('todo'),
    total: Number(/\((\d+)\)\s*$/.exec(line)![1]),
  };
}

// ================================================================ いつも流す

describe('ARC-72: Dockerfile.test と .dockerignore', () => {
  const dockerfile = instructions(read('Dockerfile.test'));

  it('ARC-72: もとのイメージが Playwright の公式イメージで、版が CI の Playwright の版と同じ', () => {
    const froms = dockerfile.filter((i) => i.op === 'FROM');
    expect(froms.length, 'FROM がある').toBeGreaterThan(0);
    // 最後の FROM がテストを流すイメージ（多段のときも）。
    const image = froms.at(-1)!.args.split(/\s+/).filter((p) => !p.startsWith('--'))[0] ?? '';
    const m = /^mcr\.microsoft\.com\/playwright(?::v?(\d+\.\d+\.\d+)(?:-[\w.]+)?)?(?:@sha256:[0-9a-f]+)?$/.exec(image);
    expect(m, `もとのイメージ ${image} が mcr.microsoft.com/playwright`).not.toBeNull();
    expect(m![1], `もとのイメージ ${image} に版が書いてある`).toBeDefined();
    expect(m![1]).toBe(ciPlaywrightVersion());
  });

  it('ARC-72: package.json と lockfile のコピーと npm ci が、ソース全体のコピーより前にある', () => {
    const copyIndex = (pred: (sources: string[]) => boolean) =>
      dockerfile.findIndex((i) => (i.op === 'COPY' || i.op === 'ADD') && pred(copySources(i.args)));
    const isWhole = (s: string) => s === '.' || s === './' || s === '*' || s === './*';
    const manifests = copyIndex((s) => !s.some(isWhole) && s.some((p) => /package\.json$|package\*\.json$/.test(p)));
    const lockfile = copyIndex((s) => !s.some(isWhole) && s.some((p) => /package-lock\.json$|package\*\.json$/.test(p)));
    const npmCi = dockerfile.findIndex((i) => i.op === 'RUN' && /\bnpm\s+ci\b/.test(i.args));
    const whole = copyIndex((s) => s.some(isWhole) || s.some((p) => /^\.?\/?src\/?$|^\.?\/?tests\/?$/.test(p)));
    expect(manifests, 'package.json だけを写す COPY がある').toBeGreaterThanOrEqual(0);
    expect(lockfile, 'lockfile（package-lock.json）を写す COPY がある').toBeGreaterThanOrEqual(0);
    expect(npmCi, 'RUN npm ci がある').toBeGreaterThanOrEqual(0);
    expect(whole, 'ソース全体を写す COPY がある').toBeGreaterThanOrEqual(0);
    expect(manifests).toBeLessThan(npmCi);
    expect(lockfile).toBeLessThan(npmCi);
    expect(npmCi).toBeLessThan(whole);
  });

  it('ARC-72: .dockerignore が node_modules・dist・.git を除いている', () => {
    const patterns = read('.dockerignore')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    const excludes = (name: string) => {
      const norm = (p: string) => p.replace(/^\.?\/+/, '').replace(/^\*\*\//, '').replace(/\/(\*\*?)?$/, '');
      const lastIndex = (pred: (p: string) => boolean) => patterns.reduce((at, p, i) => (pred(p) ? i : at), -1);
      const hit = lastIndex((p) => !p.startsWith('!') && norm(p) === name);
      const undo = lastIndex((p) => p.startsWith('!') && norm(p.slice(1)) === name);
      return hit >= 0 && hit > undo;
    };
    for (const name of ['node_modules', 'dist', '.git']) expect(excludes(name), `.dockerignore が ${name} を除く`).toBe(true);
  });
});

describe('ARC-73: CLAUDE.md の npm run test:remote の使い方', () => {
  const doc = read('CLAUDE.md');
  // test:remote を説明している段落（test:remote を含む行から、次の見出しまで）。
  const lines = doc.split('\n');
  const sectionText = (() => {
    const parts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes('test:remote')) continue;
      const start = lines[i]!.startsWith('## ') ? i : (() => {
        let s = i;
        while (s > 0 && !lines[s]!.startsWith('#')) s--;
        return s;
      })();
      let end = i + 1;
      while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
      parts.push(lines.slice(start, end).join('\n'));
    }
    return parts.join('\n');
  })();
  // test:remote を説明している箇所のうち、どこかの段落に書いてあればよい（表の行から節に飛ぶ書き方も認める）。
  const docker = (() => {
    const i = lines.findIndex((l) => /^#+ .*Docker/.test(l));
    if (i < 0) return '';
    let end = i + 1;
    while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
    return lines.slice(i, end).join('\n');
  })();
  const text = `${sectionText}\n${docker}`;

  it('ARC-73: npm run test:remote が書いてあり、前提として Docker が要ることが書いてある', () => {
    expect(doc).toContain('npm run test:remote');
    expect(text).toMatch(/Docker[^\n]*(要る|必要|前提)|(前提|必要)[^\n]*Docker/);
  });

  it('ARC-73: TEST_DOCKER_CONTEXT で context を指定し、既定が macmini であることが書いてある', () => {
    expect(text).toContain('TEST_DOCKER_CONTEXT');
    expect(text).toMatch(/既定[^\n]*macmini|macmini[^\n]*既定/);
  });

  it('ARC-73: その context がないかつながらないときは手元の Docker で流れることが書いてある', () => {
    expect(text).toMatch(/(ない|存在しない)[^\n]*(つながらない|接続できない)[^\n]*手元の\s*Docker|手元の\s*Docker[^\n]*(ない|つながらない)/);
  });

  it('ARC-73: 終了コードがコンテナの中のテストの結果になることが書いてある', () => {
    expect(text).toMatch(/終了コード[^\n]*コンテナの中/);
  });
});

// ================================================================ Docker で流す（APEX_ACCEPTANCE_DOCKER=1 のときだけ）

describe.runIf(HEAVY)('ARC-69〜ARC-71: npm run test:remote を手元の Docker で流す', () => {
  let copy = '';
  let localTotal = 0;
  let localSkipped = 0;
  let first: Run | undefined;

  beforeAll(() => {
    expect(spawnSync('docker', ['info'], { encoding: 'utf8' }).status, 'Docker が使える').toBe(0);
    expect(
      spawnSync('docker', ['context', 'inspect', MISSING_CONTEXT], { encoding: 'utf8' }).status,
      `${MISSING_CONTEXT} という docker context はない`,
    ).not.toBe(0);
    // 作業ツリーの写し（.git・dist・node_modules は写さず、node_modules は symlink にする）。
    copy = mkdtempSync(join(tmpdir(), 'apex-docker-qa-'));
    temps.push(copy);
    cpSync(ROOT, copy, {
      recursive: true,
      filter: (src) => {
        const rel = relative(ROOT, src).split(/[\\/]/)[0] ?? '';
        return !['.git', 'dist', 'node_modules', 'coverage'].includes(rel);
      },
    });
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
  });

  it('ARC-69: 手元で npm run test:browser を流したときのテストの数を数える', async () => {
    const report = join(copy, '..', `${relative(tmpdir(), copy)}-local.json`);
    temps.push(report);
    const r = await run(`npm run test:browser -- --reporter=json --outputFile=${JSON.stringify(report)}`, copy);
    expect(r.status, `手元の npm run test:browser が通る\n${tail(r.output)}`).toBe(0);
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      numTotalTests: number; numPassedTests: number; numPendingTests: number; numTodoTests: number; numFailedTests: number;
    };
    localTotal = json.numTotalTests;
    localSkipped = json.numPendingTests + json.numTodoTests;
    expect(localTotal).toBeGreaterThan(0);
    expect(json.numFailedTests).toBe(0);
  }, 40 * 60_000);

  it('ARC-69: 存在しない context を渡すと手元の Docker でイメージを作ってコンテナの中で流し、手元と同じ数が飛ばされずに通る', async () => {
    first = await run('npm run test:remote', copy, { TEST_DOCKER_CONTEXT: MISSING_CONTEXT });
    const out = first.output;
    expect(first.status, `終了コードが 0\n${tail(out)}`).toBe(0);
    // どちらで流すかがテストの前に出力に出る。手元の Docker で流したことが示される。
    const testsStart = out.search(/\bRUN\s+v\d|Test Files/);
    const head = testsStart >= 0 ? out.slice(0, testsStart) : out;
    expect(head, `手元の Docker で流すことがテストの前に出る\n${tail(head, 3000)}`).toMatch(/手元|local/i);
    // イメージを作っている（Dockerfile.test の手順が出力に出る）。
    expect(out, 'イメージを作る出力がある').toMatch(/npm ci|\[\s*\d+\/\d+\]|Step \d+\/\d+|naming to|writing image/i);
    // コンテナの中で npm run test:browser が流れた。
    expect(out).toMatch(/test:browser/);
    const s = testsSummary(out);
    expect(s, `vitest の Tests の行が出る\n${tail(out)}`).toBeDefined();
    expect(s!.failed).toBe(0);
    expect(s!.skipped, 'コンテナの中で飛ばされたテストがない').toBe(0);
    expect(localSkipped, '手元でも飛ばされたテストがない').toBe(0);
    expect(s!.passed, `コンテナの中で通った数が手元のテストの数（${localTotal}）と同じ`).toBe(localTotal);
    expect(s!.total).toBe(localTotal);
  }, 60 * 60_000);

  describe('2 回目（src/ と tests/ だけを変え、わざと失敗するテストを足す）', () => {
    let second: Run | undefined;
    const FAIL_NAME = 'docker-qa わざと失敗するテスト';

    beforeAll(async () => {
      expect(first, '1 回目の npm run test:remote を流した').toBeDefined();
      // src/ のファイルを 1 つ変える（コメントを足すだけ）。
      const srcFile = (function find(dir: string): string {
        for (const name of readdirSync(dir).sort()) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) {
            const f = find(p);
            if (f) return f;
          } else if (p.endsWith('.ts')) return p;
        }
        return '';
      })(join(copy, 'src'));
      expect(srcFile).not.toBe('');
      appendFileSync(srcFile, '\n// docker-qa: ソースだけを変えた\n');
      // tests/ にわざと失敗するブラウザのテストを足す（tests/helpers/browser.ts を import するのでブラウザの組に入る）。
      writeFileSync(
        join(copy, 'tests', 'docker-qa-fail.test.ts'),
        [
          "import { describe, expect, it } from 'vitest';",
          // このファイル自身がブラウザの組に入らないよう、import の文はつないで作る。
          `import { waitUntil } ${'from'} './helpers/${'browser'}';`,
          '',
          "describe('docker-qa', () => {",
          `  it('${FAIL_NAME.replace('docker-qa ', '')}', () => {`,
          '    expect(typeof waitUntil).toBe(\'function\');',
          '    expect(1 + 1).toBe(3);',
          '  });',
          '});',
          '',
        ].join('\n'),
      );
      expect(existsSync(join(copy, 'package.json'))).toBe(true);
      second = await run('npm run test:remote', copy, { TEST_DOCKER_CONTEXT: MISSING_CONTEXT });
    }, 60 * 60_000);

    it('ARC-70: わざと失敗させたテストがコンテナの中で失敗し、npm run test:remote の終了コードが 0 以外になる', () => {
      const out = second!.output;
      expect(second!.status, `終了コードが 0 以外\n${tail(out)}`).not.toBe(0);
      expect(second!.status, '終了コードが出ている（シグナルで止まっていない）').not.toBeNull();
      expect(out, 'わざと失敗させたテストが失敗として出る').toMatch(/docker-qa-fail\.test\.ts/);
      expect(out).toMatch(/わざと失敗するテスト/);
      const s = testsSummary(out);
      expect(s, `vitest の Tests の行が出る（コンテナの中でテストが流れた）\n${tail(out)}`).toBeDefined();
      expect(s!.failed).toBe(1);
      expect(s!.passed, 'ほかのテストは通る').toBe(localTotal);
    });

    it('ARC-71: package.json と lockfile を変えずに作り直すと、npm ci の層がキャッシュから使われる', () => {
      const out = second!.output;
      // BuildKit の plain の出力: 「#7 [3/6] RUN npm ci」のあとに「#7 CACHED」。古い builder: 「Step n/m : RUN npm ci」のあとに「Using cache」。
      const buildkit = [...out.matchAll(/^#(\d+) \[[^\]]*\] RUN npm ci\b.*$/gm)].map((m) => m[1]);
      const cachedBuildkit = buildkit.some((id) => new RegExp(`^#${id} CACHED\\s*$`, 'm').test(out));
      const legacy = /Step \d+\/\d+ : RUN npm ci[^\n]*\n\s*---> Using cache/.test(out);
      expect(buildkit.length > 0 || /Step \d+\/\d+ : RUN npm ci/.test(out), `npm ci の層を作る出力がある\n${tail(out, 4000)}`).toBe(true);
      expect(cachedBuildkit || legacy, `npm ci の層が CACHED（キャッシュから使われる）\n${out.slice(0, 6000)}`).toBe(true);
      // 依存を入れ直していない（npm ci の「added N packages」が出ない）。
      expect(out).not.toMatch(/added \d+ packages/);
      // ソースを写す層は作り直している（ソースの変更がイメージに入った）。
      expect(out).toMatch(/docker-qa-fail\.test\.ts/);
    });
  });
});
