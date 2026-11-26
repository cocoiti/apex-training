// docs/spec/architecture.md「画面の文言の辞書」（ARC-44〜ARC-48）の QA の受け入れテスト。QA が SPEC だけから書いたもの。
// 公開された入口（npm test のテスト、辞書の文言のファイル src/ui/messages/ja.ts・en.ts の `export const <言語> = {` の形、
// モードのファイルの default export の形（src/modes/types.ts の TrainingMode）、画面の文言の入口 src/ui/i18n.ts）だけを使う。
//
// リポジトリの写しを作り、辞書・モード・src/ のファイル・index.html に手を加えて、ブラウザを使わないテスト（npm test のうち
// --project unit の組）を流し、失敗することと、失敗の出力にキー・言語・モードの id・ファイルと文言が出ることを確かめる。
// 写しの中では APEX_ACCEPTANCE_NESTED=1 にして、写しを作る受け入れテストを入れ子に流さない。このファイルも入れ子では飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const JA = 'src/ui/messages/ja.ts';
const EN = 'src/ui/messages/en.ts';
const TIMEOUT = 300_000;

describe.skipIf(NESTED)('QA: 画面の文言の辞書', () => {
  const copies: string[] = [];
  afterAll(() => {
    for (const dir of copies) rmSync(dir, { recursive: true, force: true });
  });

  /** リポジトリの写しを作り、edit で手を加えて、ブラウザを使わないテストを流す。出力（標準出力と標準エラー）と終了コードを返す。 */
  function runUnit(edit: (copy: string) => void = () => undefined) {
    const copy = mkdtempSync(join(tmpdir(), 'language-dictionary-qa-'));
    copies.push(copy);
    // テストが読む SPEC や README も含め、node_modules・.git・ビルドの結果のほかをすべて写す。
    for (const entry of readdirSync(ROOT)) {
      if (['node_modules', '.git', 'dist'].includes(entry)) continue;
      cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
    // 追跡されたファイルを調べるテストのため、写しを git の作業ツリーにして全ファイルを追跡する（コミットはしない）。
    const git = spawnSync('sh', ['-c', 'git init -q && git add -A'], { cwd: copy, encoding: 'utf8' });
    if (git.status !== 0) throw new Error(`写しを git の作業ツリーにできない: ${git.stderr}`);
    edit(copy);
    const r = spawnSync('npx', ['vitest', 'run', '--project', 'unit'], {
      cwd: copy,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', APEX_ACCEPTANCE_NESTED: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });
    // 色の制御の文字を除く。
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '') };
  }

  /** 失敗したテストごとの出力（「FAIL |unit| <ファイル> > <名前>」の行から次の FAIL の行の前まで）。 */
  const failureBlocks = (output: string): Map<string, string> => {
    const blocks = new Map<string, string>();
    const lines = output.split('\n');
    let name: string | undefined;
    for (const line of lines) {
      const m = line.match(/^\s*FAIL\s+\|?unit\|?\s+(.+?)\s*$/);
      if (m) {
        name = m[1]!;
        blocks.set(name, `${blocks.get(name) ?? ''}${line}\n`);
      } else if (name) blocks.set(name, `${blocks.get(name)!}${line}\n`);
    }
    return blocks;
  };
  /** 失敗したテストの出力をつないだもの。成功したテストの名前に出る文字に引きずられないよう、失敗の部分だけを見る。 */
  const failures = (output: string) => [...failureBlocks(output).values()].join('\n');
  /** 失敗したテストのうち、出力に text を含むものの名前。 */
  const failingWith = (output: string, text: string) => [...failureBlocks(output)].filter(([, b]) => b.includes(text)).map(([n]) => n);

  /** 辞書のファイルの `export const <name> ... = {` の直後に行を足す。 */
  function addEntry(copy: string, file: string, name: 'ja' | 'en', line: string) {
    const path = join(copy, file);
    const source = readFileSync(path, 'utf8');
    const re = new RegExp(String.raw`export const ${name}\b[^=]*=\s*\{\n`);
    const m = source.match(re);
    if (!m || m.index === undefined) throw new Error(`${file} に export const ${name} = { がない`);
    const end = m.index + m[0].length;
    writeFileSync(path, `${source.slice(0, end)}  ${line}\n${source.slice(end)}`);
  }

  it('対照: 手を加えない写しでは、ブラウザを使わないテストが成功する', () => {
    const r = runUnit();
    expect(r.status, r.output.slice(-4000)).toBe(0);
  }, TIMEOUT);

  describe('ARC-44: 片方の言語の辞書にしかないキーがあると npm test が失敗し、そのキーと足りない言語が示される', () => {
    it('日本語の辞書にだけキーを足すと失敗し、キーと英語（en）が足りないことが示される', () => {
      const r = runUnit((copy) => addEntry(copy, JA, 'ja', "'qa.onlyInJa': '日本語だけの文言',"));
      expect(r.status).not.toBe(0);
      const f = failures(r.output);
      expect(f, r.output.slice(-4000)).toContain('qa.onlyInJa');
      expect(f).toMatch(/\ben\b|英語/);
    }, TIMEOUT);

    it('英語の辞書にだけキーを足すと失敗し、キーと日本語（ja）が足りないことが示される', () => {
      const r = runUnit((copy) => addEntry(copy, EN, 'en', "'qa.onlyInEn': 'English only',"));
      expect(r.status).not.toBe(0);
      const f = failures(r.output);
      expect(f, r.output.slice(-4000)).toContain('qa.onlyInEn');
      expect(f).toMatch(/\bja\b|日本語/);
    }, TIMEOUT);
  });

  describe('ARC-45: 文言が空のキーや、埋め込む場所の名前が言語の間で違うキーがあると npm test が失敗し、そのキーが示される', () => {
    it('英語の文言が空の文字列のキーがあると失敗し、そのキーが示される', () => {
      const r = runUnit((copy) => {
        addEntry(copy, JA, 'ja', "'qa.emptyInEn': '空でない文言',");
        addEntry(copy, EN, 'en', "'qa.emptyInEn': '',");
      });
      expect(r.status).not.toBe(0);
      expect(failures(r.output), r.output.slice(-4000)).toContain('qa.emptyInEn');
    }, TIMEOUT);

    it('日本語の文言が空の文字列のキーがあると失敗し、そのキーが示される', () => {
      const r = runUnit((copy) => {
        addEntry(copy, JA, 'ja', "'qa.emptyInJa': '',");
        addEntry(copy, EN, 'en', "'qa.emptyInJa': 'Not empty',");
      });
      expect(r.status).not.toBe(0);
      expect(failures(r.output), r.output.slice(-4000)).toContain('qa.emptyInJa');
    }, TIMEOUT);

    it('埋め込む場所の名前（{done} と {total}）が言語の間で違うキーがあると失敗し、そのキーが示される', () => {
      const r = runUnit((copy) => {
        addEntry(copy, JA, 'ja', "'qa.placeholder': '的: {done} 個',");
        addEntry(copy, EN, 'en', "'qa.placeholder': 'Targets: {total}',");
      });
      expect(r.status).not.toBe(0);
      expect(failures(r.output), r.output.slice(-4000)).toContain('qa.placeholder');
    }, TIMEOUT);
  });

  describe('ARC-46: 英語の名前かひとこと説明がないモードを src/modes/ に足すと npm test が失敗し、そのモードの id が示される', () => {
    /** 追いエイムのモードを元に、id・並び順・名前・説明を差し替えたモードのファイルを src/modes/aim/ に足す。 */
    const addMode = (copy: string, id: string, fields: string) =>
      writeFileSync(
        join(copy, 'src/modes/aim', `${id}.ts`),
        `import base from './tracking';\nexport default { ...base, id: '${id}', order: 990, ${fields} };\n`,
      );
    // モードを 1 つ足すと、モードの一覧をそのまま比べるほかのテストも失敗する。両方の言語を持つモードを足したときに失敗するテストを
    // 基準にして、英語がないときにだけ増える失敗に、そのモードの id が出ることを確かめる。
    let baseline: Set<string> | undefined;
    const baselineFailures = () => {
      if (!baseline) {
        const r = runUnit((copy) =>
          addMode(copy, 'qa-both-languages', "name: { ja: '受け入れの名前', en: 'Acceptance' }, description: { ja: '受け入れの説明', en: 'Acceptance description' }"),
        );
        baseline = new Set(failureBlocks(r.output).keys());
      }
      return baseline;
    };

    it.each([
      ['英語の表示名', 'qa-no-english-name', "name: { ja: '受け入れの名前' }, description: { ja: '受け入れの説明', en: 'Acceptance description' }"],
      ['英語のひとこと説明', 'qa-no-english-description', "name: { ja: '受け入れの名前', en: 'Acceptance' }, description: { ja: '受け入れの説明' }"],
    ])('%s を持たないモードを足すと、両方の言語を持つモードを足したときにない失敗が増え、その失敗にモードの id が示される', (_, id, fields) => {
      const base = baselineFailures();
      const r = runUnit((copy) => addMode(copy, id, fields));
      expect(r.status).not.toBe(0);
      const added = [...failureBlocks(r.output).keys()].filter((n) => !base.has(n));
      expect(added, `増えた失敗がない。基準の失敗: ${[...base].join(' / ')}`).not.toEqual([]);
      const withId = failingWith(r.output, id).filter((n) => !base.has(n));
      expect(withId, `増えた失敗: ${added.join(' / ')}\n${failures(r.output).slice(0, 4000)}`).not.toEqual([]);
    }, TIMEOUT * 2);
  });

  describe('ARC-47: 辞書とモードの名前の外で src/ の文字列リテラルか index.html にひらがな・カタカナを足すと npm test が失敗し、そのファイルと文言が示される', () => {
    it('src/ui/ のファイルの文字列リテラルにひらがなの文言を足すと失敗し、そのファイルと文言が示される', () => {
      const r = runUnit((copy) => writeFileSync(join(copy, 'src/ui/qa-literal.ts'), "export const qaMessage = 'ひらがなのもんごん';\n"));
      expect(r.status).not.toBe(0);
      const f = failures(r.output);
      expect(f, r.output.slice(-4000)).toContain('qa-literal.ts');
      expect(f).toContain('ひらがなのもんごん');
    }, TIMEOUT);

    it('対照: コメントにだけひらがなを書いても失敗しない', () => {
      const r = runUnit((copy) => writeFileSync(join(copy, 'src/ui/qa-comment.ts'), "// コメントのひらがなとカタカナ\nexport const qaMessage = 'English';\n"));
      expect(r.status, failures(r.output).slice(0, 4000)).toBe(0);
    }, TIMEOUT);

    it('index.html の表示する文字にカタカナの文言を足すと失敗し、index.html と文言が示される', () => {
      const r = runUnit((copy) => {
        const path = join(copy, 'index.html');
        const html = readFileSync(path, 'utf8');
        if (!html.includes('</body>')) throw new Error('index.html に </body> がない');
        writeFileSync(path, html.replace('</body>', '<p>カタカナノモンゴン</p>\n</body>'));
      });
      expect(r.status).not.toBe(0);
      const f = failures(r.output);
      expect(f, r.output.slice(-4000)).toContain('index.html');
      expect(f).toContain('カタカナノモンゴン');
    }, TIMEOUT);

    it('index.html の aria-label にひらがなの文言を足すと失敗し、index.html と文言が示される', () => {
      const r = runUnit((copy) => {
        const path = join(copy, 'index.html');
        const html = readFileSync(path, 'utf8');
        writeFileSync(path, html.replace('</body>', '<button type="button" aria-label="よみあげのなまえ">x</button>\n</body>'));
      });
      expect(r.status).not.toBe(0);
      const f = failures(r.output);
      expect(f, r.output.slice(-4000)).toContain('index.html');
      expect(f).toContain('よみあげのなまえ');
    }, TIMEOUT);
  });

  describe('ARC-48: src/sim/ が画面の文言の辞書を import していないことをテストで確かめられる', () => {
    /** src/sim/ 以下の .ts ファイル（ROOT からの相対パス）。 */
    const simFiles = (dir = join(ROOT, 'src/sim')): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return simFiles(path);
        return path.endsWith('.ts') ? [relative(ROOT, path)] : [];
      });

    it('今の src/sim/ のどのファイルも、画面の文言の辞書（src/ui/messages/）と文言の入口（src/ui/i18n）を import していない', () => {
      const files = simFiles();
      expect(files.length).toBeGreaterThan(0);
      const offenders = files.filter((file) => {
        const source = readFileSync(join(ROOT, file), 'utf8');
        return [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].some(([, spec]) => /(?:^|\/)(?:ui\/)?(?:messages|i18n)(?:\/|\.ts$|$)/.test(spec!));
      });
      expect(offenders).toEqual([]);
    });

    it('src/sim/ に辞書（src/ui/messages/ja）を import するファイルを足すと npm test が失敗し、そのファイルが示される', () => {
      const r = runUnit((copy) =>
        writeFileSync(join(copy, 'src/sim/qa-uses-messages.ts'), "import { ja } from '../ui/messages/ja';\nexport const qaTitle = ja['app.title'];\n"),
      );
      expect(r.status).not.toBe(0);
      expect(failures(r.output), r.output.slice(-4000)).toContain('qa-uses-messages.ts');
    }, TIMEOUT);

    it('src/sim/ に文言の入口（src/ui/i18n）を import するファイルを足すと npm test が失敗し、そのファイルが示される', () => {
      const r = runUnit((copy) =>
        writeFileSync(join(copy, 'src/sim/qa-uses-i18n.ts'), "import { DICTIONARIES } from '../ui/i18n';\nexport const qaCount = Object.keys(DICTIONARIES).length;\n"),
      );
      expect(r.status).not.toBe(0);
      expect(failures(r.output), r.output.slice(-4000)).toContain('qa-uses-i18n.ts');
    }, TIMEOUT);
  });
});
