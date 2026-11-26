// ブラウザのテストが開いたページの練習の乱数の種（URL の seed）を覚え、テストが失敗したときのメッセージに出す
// （docs/spec/architecture.md「テストのための乱数の種の固定」、ARC-50）。Chromium を使わないので、ブラウザを使わないテストからも読める。
import { beforeEach, onTestFailed } from 'vitest';

/** 今のテスト（とその前処理）で開いたページの種。開いた順、重なりなし。 */
let testSeeds: string[] = [];
/** このファイルで最後に開いたページの種。前処理（beforeAll）で開いたページを使い回すテストのため。 */
let lastSeed: string | undefined;

/** URL の seed の値（付いていなければ undefined）。種として読めない値もそのまま返す。 */
export function seedOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('seed') ?? undefined;
  } catch {
    return undefined;
  }
}

/** ページを開いた URL を覚える（Page.goto が呼ぶ）。seed の付いていない URL は覚えない。 */
export function noteOpenedUrl(url: string): void {
  const seed = seedOf(url);
  if (seed === undefined) return;
  lastSeed = seed;
  if (!testSeeds.includes(seed)) testSeeds.push(seed);
}

/** 失敗のメッセージに足す、使った種の文。 */
export function seedNote(seeds: readonly string[]): string {
  const list = seeds.map((s) => `seed=${s}`).join('・');
  return `（このテストで開いたページの練習の乱数の種: ${list}。同じ種で流し直すには、その種で開く）`;
}

/** 今のテストで使った種。今のテストで開いていなければ、このファイルで最後に開いたページの種。 */
export function usedSeeds(): string[] {
  if (testSeeds.length > 0) return [...testSeeds];
  return lastSeed === undefined ? [] : [lastSeed];
}

/**
 * このファイルのテストが失敗したとき、失敗のメッセージに使った種を足す。テストのファイルを集めるとき（import したとき）に
 * 1 回呼ぶ。ファイルのどの beforeEach よりも先に登録されるので、beforeEach で開いたページの種もそのテストの種に入る。
 */
export function reportSeedsOnFailure(): void {
  beforeEach(() => {
    testSeeds = [];
    onTestFailed(({ task }) => {
      const seeds = usedSeeds();
      if (seeds.length === 0) return;
      const note = seedNote(seeds);
      for (const error of task.result?.errors ?? []) {
        if (error.message.includes(note)) continue;
        const message = `${error.message}\n${note}`;
        // 表示する報告によって message か stack（先頭が message）を出すので、両方に足す。
        if (error.stack?.includes(error.message)) error.stack = error.stack.replace(error.message, message);
        error.message = message;
      }
    });
  });
}
