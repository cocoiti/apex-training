import { en } from './messages/en';
import { ja, type MessageKey } from './messages/ja';
import type { SafeStorage } from './storage';

/**
 * 表示の言語（docs/spec/screens.md「表示の言語」）。画面の文言は言語ごとの辞書（src/ui/messages/）から出し、
 * モードの名前などはモードのファイルが両方の言語で持つ（Localized）。決定の理由は docs/adr/2026-11-26-ui-language-dictionaries.md。
 * 今の言語はページに 1 つで、選び直すと登録した関数を呼ぶ（画面はそこで文言を書き直す）。
 */

export type { MessageKey } from './messages/ja';

/** 対応する言語。 */
export type Language = 'ja' | 'en';

export const LANGUAGES: readonly Language[] = ['ja', 'en'];

/** 選んだ言語を保存するキー。値は `ja` か `en`。 */
export const LANGUAGE_KEY = 'apex-training:language';

/** 両方の言語の文言（モードの名前・説明・練習の選択肢の名前など、モードのファイルが持つもの）。 */
export type Localized = Readonly<Record<Language, string>>;

/** 言語ごとの辞書。どの言語も同じキーの組を持つ。 */
export const DICTIONARIES: Readonly<Record<Language, Readonly<Record<MessageKey, string>>>> = { ja, en };

let current: Language = 'ja';
const listeners = new Set<(language: Language) => void>();

/** 今の言語。 */
export function currentLanguage(): Language {
  return current;
}

/** 言語を変える。変わったときだけ、登録した関数を登録した順に呼ぶ。 */
export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  for (const listener of [...listeners]) listener(language);
}

/** 言語が変わったときに呼ぶ関数を登録する。外すための関数を返す。 */
export function onLanguageChange(listener: (language: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 文言の埋め込む場所（`{done}` など）の名前。並びは文言に出た順。 */
export function placeholderNames(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}

/** 今の言語の文言。埋め込む場所は vars の同じ名前の値で置き換え、vars にない名前はそのまま残す。 */
export function t(key: MessageKey, vars: Readonly<Record<string, string | number>> = {}): string {
  const text = DICTIONARIES[current][key];
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** 両方の言語で持つ文言の、今の言語のもの。 */
export function localize(text: Localized): string {
  return text[current];
}

/** 保存された値などを言語として読む。`ja`・`en` でなければ undefined。 */
export function parseLanguage(value: unknown): Language | undefined {
  return value === 'ja' || value === 'en' ? value : undefined;
}

/** ブラウザの言語（navigator.language）から決める言語。`ja` で始まる（大文字・小文字は区別しない）なら日本語、それ以外（空を含む）は英語。 */
export function browserLanguage(navigatorLanguage: string | undefined): Language {
  return /^ja/i.test(navigatorLanguage ?? '') ? 'ja' : 'en';
}

/** 最初の言語。保存した値が `ja`・`en` ならそれ、なければブラウザの言語で決める。 */
export function initialLanguage(stored: string | null, navigatorLanguage: string | undefined): Language {
  return parseLanguage(stored) ?? browserLanguage(navigatorLanguage);
}

/** 保存した言語（なければブラウザの言語）を今の言語にする。 */
export function loadLanguage(storage: Pick<SafeStorage, 'get'>, navigatorLanguage: string | undefined): Language {
  const language = initialLanguage(storage.get(LANGUAGE_KEY), navigatorLanguage);
  setLanguage(language);
  return language;
}

/** 言語を選び直して保存する。保存できない環境でも投げず、ページを開いている間は選んだ言語のまま（SafeStorage のメモリ）。 */
export function chooseLanguage(storage: Pick<SafeStorage, 'set'>, language: Language): void {
  storage.set(LANGUAGE_KEY, language);
  setLanguage(language);
}
