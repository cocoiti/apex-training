/**
 * テストのための、ページの URL のクエリで決まる振る舞い（docs/spec/architecture.md「テストのための描画の省略と時計の差し替え」
 * 「テストのための乱数の種の固定」）。利用者が開く URL には付かないので、付けないときはどれも今までどおり
 * （描画する・実時間の時計・練習ごとに種を選ぶ）。
 */
export interface PageOptions {
  /** 3D を描画するか。render=off のときだけ false（WebGL の文脈を作らず、描画も呼ばない）。 */
  readonly render: boolean;
  /** ページの時計をテストから進めるか。clock=manual のときだけ true。 */
  readonly manualClock: boolean;
  /**
   * 練習の乱数の種を固定する値。seed=<0 以上 2³² 未満の 10 進の整数> のときだけその値で、このページで始める練習の種はすべてこれになる。
   * 付けないときと、値がその形でないとき（abc・-1・1.5・4294967296 など）は undefined（練習ごとに種を選ぶ）。
   */
  readonly seed: number | undefined;
}

/** seed の値の上限（これ未満）。種は 32 ビットの符号なし整数。 */
const SEED_LIMIT = 2 ** 32;

/** seed の値を種にする。0 以上 2³² 未満の 10 進の整数（数字だけ）でなければ undefined。 */
export function parseSeed(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value < SEED_LIMIT ? value : undefined;
}

/** location.search（先頭の ? はあってもなくてもよい）からページの振る舞いを決める。ほかの値は無視する。 */
export function parsePageOptions(search: string): PageOptions {
  const params = new URLSearchParams(search);
  return {
    render: params.get('render') !== 'off',
    manualClock: params.get('clock') === 'manual',
    seed: parseSeed(params.get('seed')),
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
