// 画面の文言の辞書と、辞書の外に書いた文言を調べる道具（docs/spec/architecture.md「画面の文言の辞書」、ARC-52〜ARC-56）。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/** ひらがな・カタカナ（文字の種類で見る。「・」「ー」のようにどちらの文字にも使う記号は含まない）。 */
export const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** ひらがな・カタカナ・漢字。 */
export const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** 埋め込む場所の名前（`{done}` の done）の組。並べ替え済み。 */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string))].sort();
}

/**
 * 言語ごとの辞書の問題（ARC-52, ARC-53）。片方の言語にしかないキー、文言が空のキー、埋め込む場所の名前の組が言語の間で違うキーを、
 * キーと言語を示す文で返す。問題がなければ空。
 */
export function findDictionaryProblems(dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>): string[] {
  const languages = Object.keys(dictionaries);
  const keys = [...new Set(languages.flatMap((language) => Object.keys(dictionaries[language] ?? {})))].sort();
  const problems: string[] = [];
  for (const key of keys) {
    const missing = languages.filter((language) => !Object.hasOwn(dictionaries[language] ?? {}, key));
    if (missing.length > 0) {
      problems.push(`キー "${key}" が ${missing.join('・')} の辞書にない`);
      continue;
    }
    const empty = languages.filter((language) => (dictionaries[language]?.[key] ?? '').trim() === '');
    if (empty.length > 0) problems.push(`キー "${key}" の ${empty.join('・')} の文言が空`);
    const shapes = languages.map((language) => placeholdersOf(dictionaries[language]?.[key] ?? '').join(','));
    if (new Set(shapes).size > 1) {
      problems.push(`キー "${key}" の埋め込む場所の名前が言語の間で違う（${languages.map((l, i) => `${l}: {${shapes[i]}}`).join(' / ')}）`);
    }
  }
  return problems;
}

/** 両方の言語の文言の形か。どちらかが空・文字列でないなら false。 */
function isFilledLocalized(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { ja, en } = value as Record<string, unknown>;
  return typeof ja === 'string' && ja.trim() !== '' && typeof en === 'string' && en.trim() !== '';
}

/**
 * モードの名前の問題（ARC-54）。表示名・ひとこと説明・練習の選択肢とその値の名前を、日本語と英語の両方で持たないモードを、
 * モードの id（とファイル）を示す文で返す。value はモードのファイルの default export。
 */
export function findModeNameProblems(modes: readonly { readonly file: string; readonly value: unknown }[]): string[] {
  const problems: string[] = [];
  for (const { file, value } of modes) {
    const mode = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const id = typeof mode.id === 'string' ? mode.id : '（id なし）';
    const lacks: string[] = [];
    if (!isFilledLocalized(mode.name)) lacks.push('表示名');
    if (!isFilledLocalized(mode.description)) lacks.push('ひとこと説明');
    for (const option of Array.isArray(mode.options) ? (mode.options as Record<string, unknown>[]) : []) {
      if (!isFilledLocalized(option.label)) lacks.push(`練習の選択肢 ${String(option.id)} の名前`);
      for (const choice of Array.isArray(option.choices) ? (option.choices as Record<string, unknown>[]) : []) {
        if (!isFilledLocalized(choice.name)) lacks.push(`練習の選択肢 ${String(option.id)} の値 ${String(choice.id)} の名前`);
      }
    }
    if (lacks.length > 0) problems.push(`モード "${id}"（${file}）が日本語と英語の ${lacks.join('・')} を持たない`);
  }
  return problems;
}

/** 辞書の外に書いた、ひらがな・カタカナを含む文言。 */
export interface StrayText {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** 文字列の値を持つ構文（文字列・テンプレートの文字の部分）。 */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return undefined;
}

/** モードのファイルが持つ日本語の名前（`{ ja: '…', en: '…' }` の ja の値）か。 */
function isModeName(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isIdentifier(parent.name) && parent.name.text === 'ja';
}

/**
 * 1 つのソースの文字列リテラル（コメントは除く）から、ひらがな・カタカナを含むものを探す（ARC-55）。
 * allowModeNames なら、モードのファイルが持つ日本語の名前（`ja:` の値）は除く。
 */
export function findKanaLiterals(file: string, source: string, { allowModeNames = false } = {}): StrayText[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: StrayText[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text !== undefined && KANA.test(text) && !(allowModeNames && isModeName(node))) {
      found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** 辞書のファイルを置くディレクトリ（src/ からの相対）。ここのファイルは調べない。 */
export const DICTIONARY_DIR = 'ui/messages';
/** モードのファイルを置くディレクトリ（src/ からの相対）。ここのファイルの日本語の名前は辞書の外に置いてよい。 */
export const MODES_DIR = 'modes';

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSources(path);
    return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** src/ 以下の、辞書とモードの名前の外の文字列リテラルにある、ひらがな・カタカナを含む文言（ARC-55）。file は src/ からの相対。 */
export function findStrayKanaInSources(srcDir: string): StrayText[] {
  return listSources(srcDir).flatMap((path) => {
    const file = relative(srcDir, path).split(sep).join('/');
    if (file.startsWith(`${DICTIONARY_DIR}/`)) return [];
    return findKanaLiterals(file, readFileSync(path, 'utf8'), { allowModeNames: file.startsWith(`${MODES_DIR}/`) });
  });
}

/** HTML の表示する文字と、aria-label・title・placeholder の値（コメント・script・style の中は除く）。行の番号つき。 */
export function htmlTexts(html: string): { line: number; text: string }[] {
  // 消す部分は同じ数の改行で置き換え、行の番号を保つ。
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const cleaned = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, blank);
  const lineAt = (index: number) => cleaned.slice(0, index).split('\n').length;
  const texts: { line: number; text: string }[] = [];
  for (const m of cleaned.matchAll(/<[^>]*>/g)) {
    for (const a of m[0].matchAll(/\s(aria-label|title|placeholder)\s*=\s*"([^"]*)"/g)) texts.push({ line: lineAt(m.index), text: a[2] as string });
  }
  for (const m of cleaned.replace(/<[^>]*>/g, (tag) => blank(tag)).matchAll(/[^\s][^\n]*/g)) {
    texts.push({ line: lineAt(m.index), text: m[0].trim() });
  }
  return texts.sort((a, b) => a.line - b.line);
}

/** HTML の表示する文字などにある、ひらがな・カタカナを含む文言（ARC-55）。 */
export function findKanaInHtml(file: string, html: string): StrayText[] {
  return htmlTexts(html)
    .filter((t) => KANA.test(t.text))
    .map((t) => ({ file, line: t.line, text: t.text }));
}

/** 辞書のファイル（src/ui/i18n.ts と src/ui/messages/）を参照する import か。specifier は import の文字列。 */
export function isDictionaryImport(specifier: string): boolean {
  return /(?:^|\/)ui\/(?:i18n(?:\.ts)?|messages(?:\/.*)?)$/.test(specifier);
}

/** src/sim/ 以下で、画面の文言の辞書を import しているところ（ARC-56）。file は sim のディレクトリからの相対。 */
export function findDictionaryImports(simDir: string): StrayText[] {
  return listSources(simDir).flatMap((path) => {
    const file = relative(simDir, path).split(sep).join('/');
    const sf = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: StrayText[] = [];
    const visit = (node: ts.Node): void => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        specifier = node.arguments[0].text;
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifier = node.argument.literal.text;
      }
      if (specifier !== undefined && isDictionaryImport(specifier)) {
        found.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: specifier });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  });
}
