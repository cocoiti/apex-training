/**
 * テストのための、ページの URL のクエリで決まる振る舞い（docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」）。
 * 利用者が開く URL には付かないので、付けないときはどちらも今までどおり（描画する・実時間の時計）。
 */
export interface PageOptions {
  /** 3D を描画するか。render=off のときだけ false（WebGL の文脈を作らず、描画も呼ばない）。 */
  readonly render: boolean;
  /** ページの時計をテストから進めるか。clock=manual のときだけ true。 */
  readonly manualClock: boolean;
}

/** location.search（先頭の ? はあってもなくてもよい）からページの振る舞いを決める。ほかの値は無視する。 */
export function parsePageOptions(search: string): PageOptions {
  const params = new URLSearchParams(search);
  return {
    render: params.get('render') !== 'off',
    manualClock: params.get('clock') === 'manual',
  };
}

/** clock=manual のとき、テストから時計を進めるために window に置く名前。 */
export const TEST_CLOCK_GLOBAL = '__apexTestClock';

/** テストから時計を進める口。 */
export interface TestClockHandle {
  /** seconds 秒進め、行った描画の回数を返す。frameSeconds（省略時は 1/60 秒）ごとに描画を 1 回行う。 */
  advance(seconds: number, frameSeconds?: number): number;
  /** 今の時計の時刻（秒）。 */
  now(): number;
}
