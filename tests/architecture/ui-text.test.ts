import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DICTIONARIES } from '../../src/ui/i18n';
import {
  findDictionaryImports,
  findDictionaryProblems,
  findKanaInHtml,
  findKanaLiterals,
  findModeNameProblems,
  findStrayKanaInSources,
  isDictionaryImport,
} from '../helpers/ui-text';

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');
const SIM = join(SRC, 'sim');

/** src/modes/<category>/*.ts のモードのファイルの default export（登録の検査を通す前のもの）。 */
const modeFiles = Object.entries(import.meta.glob<{ default?: unknown }>('../../src/modes/*/*.ts', { eager: true })).map(([path, module]) => ({
  file: path.replace(/^\.\.\/\.\.\//, ''),
  value: module.default,
}));

describe('画面の文言の辞書（docs/spec/architecture.md「画面の文言の辞書」）', () => {
  it('ARC-44・ARC-45: 日本語と英語の辞書はキーの組が一致し、どの文言も空でなく、埋め込む場所の名前の組がキーごとに同じ', () => {
    expect(findDictionaryProblems(DICTIONARIES)).toEqual([]);
    expect(Object.keys(DICTIONARIES.ja).length).toBeGreaterThan(100);
  });

  it('ARC-44: 片方の言語の辞書にだけあるキーを足すと、そのキーと足りない言語が示される', () => {
    expect(findDictionaryProblems({ ja: { ...DICTIONARIES.ja, 'extra.only': '日本語だけ' }, en: DICTIONARIES.en })).toEqual([
      'キー "extra.only" が en の辞書にない',
    ]);
    expect(findDictionaryProblems({ ja: DICTIONARIES.ja, en: { ...DICTIONARIES.en, 'extra.english': 'English only' } })).toEqual([
      'キー "extra.english" が ja の辞書にない',
    ]);
  });

  it('ARC-45: 文言が空のキーと、埋め込む場所の名前が言語の間で違うキーが示される', () => {
    expect(findDictionaryProblems({ ja: { ...DICTIONARIES.ja, 'top.start': '' }, en: DICTIONARIES.en })).toEqual(['キー "top.start" の ja の文言が空']);
    expect(findDictionaryProblems({ ja: DICTIONARIES.ja, en: { ...DICTIONARIES.en, 'mode.flickTargets': 'Targets: {count} / {total}' } })).toEqual([
      'キー "mode.flickTargets" の埋め込む場所の名前が言語の間で違う（ja: {done,total} / en: {count,total}）',
    ]);
  });
});

describe('モードの名前（docs/spec/modes.md「モードの登録」）', () => {
  it('ARC-46: src/modes/ のモードのファイルはどれも、両方の言語の表示名・ひとこと説明・練習の選択肢とその値の名前を持つ', () => {
    expect(modeFiles.map((m) => m.file).sort()).toEqual([
      'src/modes/aim/flick.ts',
      'src/modes/aim/tracking-recoil.ts',
      'src/modes/aim/tracking.ts',
      'src/modes/recoil/ghost.ts',
    ]);
    expect(findModeNameProblems(modeFiles)).toEqual([]);
  });

  it('ARC-46: 英語の表示名かひとこと説明を持たないモードのファイルを足すと、そのモードの id が示される', () => {
    const added = [
      ...modeFiles,
      { file: 'src/modes/aim/no-english.ts', value: { id: 'no-english', name: { ja: '英語なし' }, description: { ja: '説明', en: 'About' } } },
      { file: 'src/modes/aim/old-shape.ts', value: { id: 'old-shape', name: '古い形', description: '古い形の説明' } },
      {
        file: 'src/modes/aim/no-choice.ts',
        value: {
          id: 'no-choice',
          name: { ja: '選択肢', en: 'Choice' },
          description: { ja: '説明', en: 'About' },
          options: [{ id: 'speed', label: { ja: '速さ', en: 'Speed' }, choices: [{ id: 'slow', name: { ja: '遅い', en: '' } }] }],
        },
      },
    ];
    expect(findModeNameProblems(added)).toEqual([
      'モード "no-english"（src/modes/aim/no-english.ts）が日本語と英語の 表示名 を持たない',
      'モード "old-shape"（src/modes/aim/old-shape.ts）が日本語と英語の 表示名・ひとこと説明 を持たない',
      'モード "no-choice"（src/modes/aim/no-choice.ts）が日本語と英語の 練習の選択肢 speed の値 slow の名前 を持たない',
    ]);
  });
});

describe('辞書の外の文言（ARC-47）', () => {
  let copy: string | undefined;
  afterEach(() => {
    if (copy) rmSync(copy, { recursive: true, force: true });
    copy = undefined;
  });

  it('ARC-47: 辞書とモードの名前の外の src/ の文字列リテラルと index.html の表示する文字・aria-label・title・placeholder に、ひらがな・カタカナがない', () => {
    expect(findStrayKanaInSources(SRC)).toEqual([]);
    expect(findKanaInHtml('index.html', readFileSync(join(ROOT, 'index.html'), 'utf8'))).toEqual([]);
  });

  it('ARC-47: src/ の写しにひらがな・カタカナを含む文言を書いたファイルを足すと、そのファイルと文言が示される', () => {
    copy = mkdtempSync(join(tmpdir(), 'ui-text-'));
    cpSync(SRC, copy, { recursive: true });
    writeFileSync(join(copy, 'ui', 'added.ts'), "// コメントは調べない\nexport const label = 'もう一度';\nexport const ok = 'Try again';\n");
    writeFileSync(join(copy, 'modes', 'aim', 'added-mode.ts'), "export const name = { ja: 'モード名', en: 'Mode' };\nexport const stray = `残り ${1} 回`;\n");
    expect(findStrayKanaInSources(copy)).toEqual([
      { file: 'modes/aim/added-mode.ts', line: 2, text: '残り ' },
      { file: 'ui/added.ts', line: 2, text: 'もう一度' },
    ]);
  });

  it('ARC-47: index.html の表示する文字と aria-label・title・placeholder の文言は見つかり、コメントと辞書のキーは見つからない', () => {
    const html = [
      '<!-- コメントは調べない -->',
      '<p data-i18n="top.start"></p>',
      '<button aria-label="閉じる">x</button>',
      '<p>開始します</p>',
      '<input placeholder="なまえ" title="ヒント" />',
      '<p>言語 / Language</p>',
    ].join('\n');
    expect(findKanaInHtml('index.html', html)).toEqual([
      { file: 'index.html', line: 3, text: '閉じる' },
      { file: 'index.html', line: 4, text: '開始します' },
      { file: 'index.html', line: 5, text: 'なまえ' },
      { file: 'index.html', line: 5, text: 'ヒント' },
    ]);
  });

  it('文字列リテラルの調べ方: テンプレートの文字の部分も調べ、コメントと漢字だけの文言とモードの日本語の名前（ja の値）は除く', () => {
    const source = "const a = `残り: ${n}`; const k = '的'; // コメント\nconst m = { ja: 'フリック', en: 'Flick' };\nconst b = '・';\n";
    expect(findKanaLiterals('a.ts', source, { allowModeNames: true }).map((f) => f.text)).toEqual(['残り: ']);
    expect(findKanaLiterals('a.ts', source).map((f) => f.text)).toEqual(['残り: ', 'フリック']);
  });
});

describe('src/sim/ と辞書（ARC-48）', () => {
  it('ARC-48: src/sim/ 以下のファイルは画面の文言の辞書を import していない', () => {
    expect(findDictionaryImports(SIM)).toEqual([]);
  });

  it('ARC-48: 辞書を import するファイルを足した src/sim/ の写しでは、そのファイルが示される', () => {
    const copy = mkdtempSync(join(tmpdir(), 'sim-dictionary-'));
    try {
      cpSync(SIM, copy, { recursive: true });
      writeFileSync(join(copy, 'uses-text.ts'), "import { t } from '../ui/i18n';\nexport const label = () => t('top.start');\n");
      expect(findDictionaryImports(copy)).toEqual([{ file: 'uses-text.ts', line: 1, text: '../ui/i18n' }]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it.each([
    ['../ui/i18n', true],
    ['../../ui/i18n.ts', true],
    ['../ui/messages/ja', true],
    ['../ui/messages', true],
    ['./weapon', false],
    ['../ui/storage', false],
  ])('%s は辞書の import か: %s', (specifier, expected) => {
    expect(isDictionaryImport(specifier)).toBe(expected);
  });
});
