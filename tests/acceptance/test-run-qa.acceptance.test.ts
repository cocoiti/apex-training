// docs/spec/architecture.md の受け入れ条件（ARC-18 〜 ARC-22）の受け入れテスト（QA）。
// 公開された入口（CLAUDE.md のコマンド、package.json の scripts、vitest の CLI、tests/ のテストのコード）だけを使う。
//
// - ARC-18・ARC-22・ARC-21（一覧）: いつも流す。テストのコードを TypeScript の構文木で調べる。
// - ARC-19・ARC-20・ARC-21（実際に流す）: npm test を何度も流すため数十分かかる。環境変数 APEX_ACCEPTANCE_STRESS=1 のときだけ流す。
//   APEX_ACCEPTANCE_STRESS=1 npx vitest run tests/acceptance/test-run-qa.acceptance.test.ts
// 入れ子で流す npm test にはこの環境変数を渡さないので、自分自身を入れ子で流さない。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const STRESS = process.env.APEX_ACCEPTANCE_STRESS === '1' && !NESTED;
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 共通

/** tests/ 以下の .ts のファイル（ROOT からの相対パス）。 */
function testCodeFiles(dir = join(ROOT, 'tests')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testCodeFiles(full));
    else if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name)) out.push(relative(ROOT, full));
  }
  return out.sort();
}

interface Finding { file: string; line: number; reason: string; text: string }

function parse(file: string, source: string, kind = ts.ScriptKind.TS) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function finding(sf: ts.SourceFile, node: ts.Node, reason: string, lineOffset = 0): Finding {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;
  return { file: sf.fileName, line, reason, text: node.getText(sf).slice(0, 120) };
}

const calleeName = (call: ts.CallExpression): string | undefined => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
};

/** 0 以外の数のリテラルか。 */
const nonZeroNumber = (node: ts.Node | undefined): node is ts.NumericLiteral =>
  !!node && ts.isNumericLiteral(node) && Number(node.text.replace(/_/g, '')) !== 0;

/** it.each / describe.each / test.each の引数の中（決まった書き方の見本の表）か。 */
function insideEachTable(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && calleeName(n) === 'each') return true;
  }
  return false;
}

/** 文字列（文字列のリテラル・テンプレート）の中身。テンプレートの ${...} は 0 に置き換える。 */
function stringText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `0${s.literal.text}`).join('');
  return undefined;
}

// ---------------------------------------------------------------- ARC-18

const PORT_IN_STRING = /(?:--port[=\s]+|remote-debugging-port[=\s]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):)([1-9]\d{0,4})\b/;

/** サーバーの待ち受けやブラウザの遠隔操作に、決まったポート番号（0 以外の数）を渡している箇所。 */
function findFixedPorts(file: string, source: string): Finding[] {
  const sf = parse(file, source);
  const found: Finding[] = [];
  const visit = (node: ts.Node) => {
    // server.listen(3100) / listen(3100, ...)
    if (ts.isCallExpression(node)) {
      const name = calleeName(node) ?? '';
      if (name === 'listen' && nonZeroNumber(node.arguments[0])) found.push(finding(sf, node, 'listen に決まったポート番号を渡している'));
      // serveStatic(dir, base, 3110) / launchBrowser(exe, 9222) のように、待ち受け・起動の関数に番号を渡す。
      if (/listen|serve|launch|connect|createServer|preview|startServer/i.test(name) && name !== 'listen') {
        for (const arg of node.arguments) {
          if (nonZeroNumber(arg) && Number(arg.text) >= 1024 && Number(arg.text) <= 65535) {
            found.push(finding(sf, node, `${name} にポート番号らしい数を渡している`));
          }
        }
      }
    }
    // { port: 3100 } / { hmrPort: 3100 }
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
      if (/port$/i.test(key) && nonZeroNumber(node.initializer)) found.push(finding(sf, node, `${key} に決まった番号を指定している`));
    }
    // const PORT = 3100 / let devPort = 3100
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /port/i.test(node.name.text) && nonZeroNumber(node.initializer)) {
      found.push(finding(sf, node, 'ポート番号の変数に決まった番号を入れている'));
    }
    // process.env.PORT ?? 3100 のような既定値
    if (ts.isBinaryExpression(node) && /port/i.test(node.left.getText(sf)) && nonZeroNumber(node.right)
      && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      found.push(finding(sf, node, 'ポート番号の既定値に決まった番号を入れている'));
    }
    // '--port 3100' / '--remote-debugging-port=9222' / 'http://127.0.0.1:3104'
    const text = stringText(node);
    if (text !== undefined && !insideEachTable(node)) {
      const m = PORT_IN_STRING.exec(text);
      if (m) found.push(finding(sf, node, `文字列に決まったポート番号 ${m[1]} を書いている`));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('ARC-18: tests/ のテストのコードに、待ち受け・遠隔操作へ決まったポート番号を渡している箇所がない', () => {
  it('tests/ 以下のすべてのテストのコードを調べても見つからない', () => {
    const files = testCodeFiles();
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((f) => findFixedPorts(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });

  // 調べ方が書き方の違いを見落とさないことを、決まったポートを渡す書き方の見本で確かめる。
  it.each([
    ['server.listen(3109, "127.0.0.1", ok);'],
    ['await new Promise((r) => server.listen(3133, r));'],
    ['createServer({ server: { port: 3108, strictPort: true } });'],
    ['const STATIC_PORT = 3106;'],
    ['const port = Number(process.env.PORT ?? 3100);'],
    ["spawn(chrome, ['--headless', '--remote-debugging-port=9222']);"],
    ["spawnSync('npx vite --port 3100', { shell: true });"],
    ['await serveStatic(out, BASE, 3110);'],
    ['await launchBrowser(chromium!, 9222);'],
    ['const origin = `http://127.0.0.1:3104`;'],
    ["await fetch('http://localhost:3100/apex-training/');"],
  ])('決まったポートを渡す書き方を見つける: %s', (line) => {
    expect(findFixedPorts('sample.ts', `const a = 1;\n${line}\n`).length).toBeGreaterThan(0);
  });

  it.each([
    ['server.listen(0, "127.0.0.1", ok);'],
    ['createServer({ server: { port: 0, strictPort: true } });'],
    ["spawn(chrome, ['--remote-debugging-port=0']);"],
    ['const origin = `http://127.0.0.1:${portOf(server)}`;'],
    ['setTimeout(done, 3000);'],
    ["await fetch('https://cocoiti.github.io/apex-training/');"],
  ])('ポート 0 や読み取った番号を使う書き方は見つけない: %s', (line) => {
    expect(findFixedPorts('sample.ts', line)).toEqual([]);
  });
});

// ---------------------------------------------------------------- ARC-21（一覧）

/** CLAUDE.md の技術スタックの表から、目的ごとのコマンドを読む。 */
function commandsFromClaudeMd(dir = ROOT): Record<string, string> {
  const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  const commands: Record<string, string> = {};
  for (const m of text.matchAll(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`/gm)) commands[m[1]!] = m[2]!;
  return commands;
}

function testCommands(dir = ROOT) {
  const commands = commandsFromClaudeMd(dir);
  const entries = Object.entries(commands);
  const browser = entries.find(([k]) => /ブラウザ|Chromium/.test(k) && /だけ/.test(k) && !/使わない|以外/.test(k))?.[1];
  const unit = entries.find(([k]) => /ブラウザ/.test(k) && /使わない|以外/.test(k))?.[1];
  const all = commands['単体テスト'] ?? commands['テスト'];
  return { browser, unit, all };
}

/** `npm run X` / `npm test` を package.json の scripts の中身にする。 */
function scriptOf(command: string, dir = ROOT): string {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const m = /^npm (?:run |run-script )?(\S+)$/.exec(command.trim());
  expect(m, `npm のスクリプトの形でない: ${command}`).not.toBeNull();
  const name = m![1] === 'test' ? 'test' : m![1]!;
  const script = pkg.scripts[name];
  expect(script, `package.json に ${name} がない`).toBeDefined();
  return script!;
}

/** vitest run の引数のまま、流れるテストのファイルを vitest list で一覧にする。 */
function listedFiles(command: string): string[] {
  const script = scriptOf(command);
  const m = /^vitest run(.*)$/.exec(script.trim());
  expect(m, `vitest run で流すスクリプトでない: ${script}`).not.toBeNull();
  const result = spawnSync(`npx vitest list --filesOnly --json${m![1]}`, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  expect(result.status, result.stderr).toBe(0);
  const list = JSON.parse(result.stdout.slice(result.stdout.indexOf('['))) as { file: string }[];
  return [...new Set(list.map((x) => relative(ROOT, x.file)))].sort();
}

/**
 * Chromium を使うテストのファイルか。tests/ の中の import をたどり、Chromium を探す・起動する関数
 * （findChromium・launchBrowser、または chrome / chromium を spawn する処理）を呼ぶか、それを含むファイルを import するか。
 */
function makeUsesChromium() {
  const memo = new Map<string, boolean>();
  const launchesDirectly = (file: string): boolean => {
    const sf = parse(file, readFileSync(join(ROOT, file), 'utf8'));
    let hit = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name === 'findChromium' || name === 'launchBrowser') hit = true;
        if ((name === 'spawn' || name === 'execFile') && /chrom/i.test(node.arguments[0]?.getText(sf) ?? '')) hit = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return hit;
  };
  const localImports = (file: string): string[] => {
    const sf = parse(file, readFileSync(join(ROOT, file), 'utf8'));
    const out: string[] = [];
    for (const st of sf.statements) {
      if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        if (!spec.startsWith('.')) continue;
        const base = resolve(ROOT, dirname(file), spec);
        for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
          const rel = relative(ROOT, cand);
          if (rel.startsWith('tests/') && existsSync(cand) && /\.ts$/.test(cand)) { out.push(rel); break; }
        }
      }
    }
    return out;
  };
  const uses = (file: string, seen = new Set<string>()): boolean => {
    if (memo.has(file)) return memo.get(file)!;
    if (seen.has(file)) return false;
    seen.add(file);
    const result = launchesDirectly(file) || localImports(file).some((f) => uses(f, seen));
    memo.set(file, result);
    return result;
  };
  return (file: string) => uses(file);
}

describe('ARC-21: ブラウザのテストだけ・それ以外だけを流すコマンドで、流れるファイルが Chromium の使用で分かれる', () => {
  it('CLAUDE.md に 2 つのコマンドが書いてあり、流れるファイルが Chromium の使用で分かれ、合わせると npm test と一致する', () => {
    const { browser, unit, all } = testCommands();
    expect(browser, 'CLAUDE.md にブラウザのテストだけを流すコマンドがない').toBeDefined();
    expect(unit, 'CLAUDE.md にそれ以外だけを流すコマンドがない').toBeDefined();
    expect(all, 'CLAUDE.md にテストのコマンドがない').toBeDefined();

    const browserFiles = listedFiles(browser!);
    const unitFiles = listedFiles(unit!);
    const allFiles = listedFiles(all!);
    const usesChromium = makeUsesChromium();

    expect(browserFiles.length).toBeGreaterThan(0);
    expect(unitFiles.length).toBeGreaterThan(0);
    expect(browserFiles.filter((f) => !usesChromium(f)), 'ブラウザのコマンドで Chromium を使わないファイルが流れる').toEqual([]);
    expect(unitFiles.filter((f) => usesChromium(f)), 'それ以外のコマンドで Chromium を使うファイルが流れる').toEqual([]);
    expect([...new Set([...browserFiles, ...unitFiles])].sort()).toEqual(allFiles);
    // npm test で流れる Chromium を使うファイルは、すべてブラウザのコマンドで流れる。
    expect(allFiles.filter((f) => usesChromium(f))).toEqual(browserFiles);
  }, 120_000);
});

// ---------------------------------------------------------------- ARC-22

/** ループ（for / while / do）の中で、条件を確かめる if を含むか。条件を確かめながら間を置く待ちは sleep で画面の状態を待つことにならない。 */
function insidePollingLoop(node: ts.Node): boolean {
  // 関数の宣言・メソッドの境目で打ち切る（その関数がループの中で呼ばれるかは分からない）。
  // Promise の executor など、ループの中に直接書かれた関数式は越えてよい。
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isForStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      let hasCheck = false;
      const visit = (m: ts.Node) => { if (ts.isIfStatement(m)) hasCheck = true; else ts.forEachChild(m, visit); };
      visit(n.statement);
      return hasCheck;
    }
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return false;
  }
  return false;
}

/** Promise の executor が setTimeout を呼ぶだけ（ほかに resolve する道がない）か。 */
function executorOnlySetsTimeout(executor: ts.Node): ts.CallExpression | undefined {
  if (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor)) return undefined;
  const body = executor.body;
  let only: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return undefined;
    const st = body.statements[0]!;
    if (ts.isExpressionStatement(st)) only = st.expression;
    else if (ts.isReturnStatement(st)) only = st.expression;
  } else only = body;
  if (only && ts.isCallExpression(only) && calleeName(only) === 'setTimeout') return only;
  return undefined;
}

const SLEEP_NAMES = /^(sleep|delay|wait|pause|waitForTimeout|setTimeoutPromise)$/;

/** 固定の時間だけ待つ sleep の箇所。文字列の中のページで評価するコードも JavaScript として調べる。 */
function findSleeps(file: string, source: string, kind = ts.ScriptKind.TS, lineOffset = 0): Finding[] {
  const sf = parse(file, source, kind);
  const found: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(node:)?timers\/promises$/.test(node.moduleSpecifier.text)) {
      found.push(finding(sf, node, 'timers/promises（決まった時間を待つ setTimeout）を使っている', lineOffset));
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Promise' && node.arguments?.[0]) {
      const timeout = executorOnlySetsTimeout(node.arguments[0]);
      if (timeout && !insidePollingLoop(node)) found.push(finding(sf, node, 'setTimeout を待つだけの Promise（sleep）', lineOffset));
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node) ?? '';
      // sleep(300) / page.waitForTimeout(300) / delay(300)
      if (SLEEP_NAMES.test(name) && node.arguments.length === 1 && ts.isNumericLiteral(node.arguments[0]!)) {
        if (!insidePollingLoop(node)) found.push(finding(sf, node, `${name}(数) で決まった時間だけ待っている`, lineOffset));
      }
      // require('timers/promises')
      if (name === 'require' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && /timers\/promises/.test(node.arguments[0].text)) {
        found.push(finding(sf, node, 'timers/promises を使っている', lineOffset));
      }
    }
    // page.evaluate(`...`) などに渡す、ページで動かすコードの文字列も調べる。
    const text = stringText(node);
    if (text !== undefined && /setTimeout|sleep|delay/.test(text)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + lineOffset;
      found.push(...findSleeps(file, text, ts.ScriptKind.JS, line));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** ブラウザを使うテストのファイルと、それが import する tests/ の中のファイル。 */
function browserTestCode(): string[] {
  const usesChromium = makeUsesChromium();
  const tests = testCodeFiles().filter((f) => /\.test\.ts$/.test(f) && usesChromium(f));
  const out = new Set<string>();
  const add = (file: string) => {
    if (out.has(file)) return;
    out.add(file);
    const sf = parse(file, readFileSync(join(ROOT, file), 'utf8'));
    for (const st of sf.statements) {
      if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith('.')) {
        const base = resolve(ROOT, dirname(file), st.moduleSpecifier.text);
        for (const cand of [base, `${base}.ts`]) {
          const rel = relative(ROOT, cand);
          if (rel.startsWith('tests/') && /\.ts$/.test(cand) && existsSync(cand)) { add(rel); break; }
        }
      }
    }
  };
  tests.forEach(add);
  return [...out].sort();
}

describe('ARC-22: ブラウザを使うテストのコードに、固定の時間だけ待つ sleep で画面の状態を待つ箇所がない', () => {
  it('ブラウザを使うテストのファイルと、その import する tests/ のファイルを調べても見つからない', () => {
    const files = browserTestCode();
    expect(files.filter((f) => /\.test\.ts$/.test(f)).length).toBeGreaterThan(0);
    const found = files.flatMap((f) => findSleeps(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });

  it.each([
    ['await new Promise((r) => setTimeout(r, 300));'],
    ['await new Promise<void>((resolve) => { setTimeout(resolve, 500); });'],
    ['await new Promise((resolve) => setTimeout(() => resolve(), 300));'],
    ['const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));'],
    ['await sleep(1000);'],
    ['await page.waitForTimeout(200);'],
    ["import { setTimeout as wait } from 'node:timers/promises';"],
    ['await page.evaluate(`new Promise((r) => setTimeout(r, 300))`);'],
    ['for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 100)); }'],
  ])('固定の時間だけ待つ書き方を見つける: %s', (line) => {
    expect(findSleeps('sample.ts', `const a = 1;\n${line}\n`).length).toBeGreaterThan(0);
  });

  it.each([
    ['for (;;) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }'],
    ['await new Promise((resolve) => { const t = setTimeout(() => resolve(false), 1000); el.addEventListener("load", () => { clearTimeout(t); resolve(true); }); });'],
    ['setTimeout(() => document.dispatchEvent(new Event("x")), 0);'],
    ['await page.waitFor("document.readyState === \\"complete\\"");'],
  ])('条件を確かめて待つ書き方は見つけない: %s', (line) => {
    expect(findSleeps('sample.ts', line)).toEqual([]);
  });
});

// ---------------------------------------------------------------- ARC-19・ARC-20・ARC-21（実際に流す）

interface RunResult { status: number | null; output: string; files: string[]; failed: string[]; numFailed: number; numTotal: number }

/** コマンドを流し、vitest の json の結果も書き出させて読む。入れ子でこのファイルの重い確かめを流さないよう、STRESS の環境変数は外す。 */
function runCommand(command: string, cwd: string, tag: string): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), `arc-qa-${tag}-`));
  temps.push(dir);
  const json = join(dir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.APEX_ACCEPTANCE_STRESS;
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  delete env.NODE_ENV;
  const full = `${command} -- --reporter=default --reporter=json --outputFile.json="${json}"`;
  return new Promise((done) => {
    const child = spawn(full, { cwd, shell: true, env });
    let output = '';
    child.stdout.on('data', (d) => { output += String(d); });
    child.stderr.on('data', (d) => { output += String(d); });
    child.on('close', (status) => {
      let files: string[] = [];
      let failed: string[] = [];
      let numFailed = -1;
      let numTotal = -1;
      if (existsSync(json)) {
        const r = JSON.parse(readFileSync(json, 'utf8')) as {
          numFailedTests: number; numTotalTests: number; testResults: { name: string; status: string; assertionResults: { fullName: string; status: string }[] }[];
        };
        files = [...new Set(r.testResults.map((t) => relative(cwd, t.name)))].sort();
        failed = r.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => `${relative(cwd, t.name)} > ${a.fullName}`));
        numFailed = r.numFailedTests;
        numTotal = r.numTotalTests;
      }
      done({ status, output, files, failed, numFailed, numTotal });
    });
  });
}

const PORT_CONFLICT = /EADDRINUSE|address already in use|Port \d+ is (already )?in use|ポート.*使用中/i;

describe.skipIf(!STRESS)('ARC-21（実際に流す）: 2 つのコマンドで流れたファイルを合わせると npm test と一致する', () => {
  it('ブラウザのコマンドでは Chromium を使うファイルだけが、それ以外のコマンドでは使わないファイルだけが流れる', async () => {
    const { browser, unit, all } = testCommands();
    const usesChromium = makeUsesChromium();
    const b = await runCommand(browser!, ROOT, 'browser');
    const u = await runCommand(unit!, ROOT, 'unit');
    const a = await runCommand(all!, ROOT, 'all');
    expect(b.files.length, b.output.slice(-3000)).toBeGreaterThan(0);
    expect(u.files.length, u.output.slice(-3000)).toBeGreaterThan(0);
    expect(b.files.filter((f) => !usesChromium(f))).toEqual([]);
    expect(u.files.filter((f) => usesChromium(f))).toEqual([]);
    expect([...new Set([...b.files, ...u.files])].sort()).toEqual(a.files);
  }, 3_600_000);
});

describe.skipIf(!STRESS)('ARC-20: 1 つの作業ツリーで npm test を 3 回続けて流すと 3 回とも全件が通る', () => {
  it('3 回とも終了コード 0 で、失敗したテストがない', async () => {
    const { all } = testCommands();
    const results: RunResult[] = [];
    for (let i = 1; i <= 3; i++) results.push(await runCommand(all!, ROOT, `repeat${i}`));
    const summary = results.map((r, i) => `#${i + 1}: status=${r.status} failed=${r.numFailed}/${r.numTotal}\n  ${r.failed.join('\n  ')}`).join('\n');
    for (const r of results) {
      expect(r.numTotal, summary).toBeGreaterThan(0);
      expect(r.failed, summary).toEqual([]);
      expect(r.status, summary).toBe(0);
    }
  }, 7_200_000);
});

describe.skipIf(!STRESS)('ARC-19: 同じマシンの 2 つの作業ツリーで同時に npm test を流しても、ポートの衝突で落ちない', () => {
  it('この作業ツリーと、もう 1 つの作業ツリー（clone）で同時に流して、どちらにもポートの衝突の誤りが出ない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arc19-'));
    temps.push(dir);
    const clone = spawnSync(`git clone --quiet "${ROOT}" repo`, { cwd: dir, shell: true, encoding: 'utf8' });
    expect(clone.status, clone.stderr).toBe(0);
    const other = join(dir, 'repo');
    symlinkSync(join(ROOT, 'node_modules'), join(other, 'node_modules'), 'dir');

    const { all } = testCommands();
    const [mine, theirs] = await Promise.all([runCommand(all!, ROOT, 'wt1'), runCommand(all!, other, 'wt2')]);
    const report = (r: RunResult) => `status=${r.status} failed=${r.numFailed}/${r.numTotal}\n  ${r.failed.join('\n  ')}`;
    for (const [name, r] of [['この作業ツリー', mine], ['もう 1 つの作業ツリー', theirs]] as const) {
      const conflict = r.output.split('\n').filter((l) => PORT_CONFLICT.test(l));
      expect(conflict, `${name} でポートの衝突: ${report(r)}`).toEqual([]);
      expect(r.numTotal, `${name} のテストが流れていない: ${r.output.slice(-3000)}`).toBeGreaterThan(0);
    }
    // 参考: ポート以外の理由での失敗は ARC-20 で見る。ここでは結果を残すだけにする。
    console.log(`ARC-19 この作業ツリー: ${report(mine)}\nARC-19 もう 1 つの作業ツリー: ${report(theirs)}`);
  }, 3_600_000);
});
