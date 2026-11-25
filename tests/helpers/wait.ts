// テストで、期待する状態になるまで条件を確かめて待つ（決まった時間の sleep で待たない。docs/spec/architecture.md ARC-22）。

/**
 * 条件が真（undefined・false・null 以外）になるまで、interval ごとに確かめて待つ（docs/spec/architecture.md「テストの実行」）。
 * timeout を過ぎたら、what（何を待っていたか）を示して失敗する。条件の値を返す。
 */
export async function waitUntil<T>(
  check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  what: string,
  { timeout = 10_000, interval = 50 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      // 遷移の途中などで確かめられないときは続けて待つ。
      last = error;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`${timeout} ms 待っても次の状態にならない: ${what}${last ? `（最後のエラー: ${String(last)}）` : ''}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}
