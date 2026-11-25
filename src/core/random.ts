/** 種付きの乱数。シミュレーションの乱数はすべてこれから取る。 */
export interface Random {
  /** 0 以上 1 未満の数を返す。 */
  next(): number;
}

/**
 * mulberry32 による種付きの乱数を作る。種が同じなら同じ列になる。
 * 種は 32 ビットの整数として扱う。
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
