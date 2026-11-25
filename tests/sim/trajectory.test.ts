import { describe, expect, it } from 'vitest';
import { aimTrajectory } from '../../src/sim/trajectory';

const DT = 1 / 120;

describe('照準の軌道', () => {
  it('アクションがない記録の軌道は時刻 0 の開始時の照準だけ', () => {
    expect(aimTrajectory({ actions: [] }, { yaw: 3, pitch: -2 })).toEqual([{ time: 0, yaw: 3, pitch: -2 }]);
  });

  it('ステップの終わりごとに 1 点で、最後のアクションを消費するステップの終わりまで続く', () => {
    const points = aimTrajectory({ actions: [{ time: 0.02, action: { type: 'look', yaw: 1, pitch: 0 } }] }, { yaw: 0, pitch: 0 });
    // 0.02 秒の入力は [2/120, 3/120) のステップ（3 つ目）で消費される。
    expect(points.map((p) => p.time)).toEqual([0, DT, 2 * DT, 3 * DT]);
    expect(points.map((p) => p.yaw)).toEqual([0, 0, 0, 1]);
  });

  it('fire・ads は照準を変えないが、最後のアクションなら軌道はそのステップまで続く', () => {
    const points = aimTrajectory(
      {
        actions: [
          { time: 0, action: { type: 'look', yaw: 2, pitch: 0 } },
          { time: 0.03, action: { type: 'fire', pressed: true } },
        ],
      },
      { yaw: 0, pitch: 0 },
    );
    expect(points).toHaveLength(5);
    expect(points.at(-1)).toEqual({ time: 4 * DT, yaw: 2, pitch: 0 });
  });

  it('ピッチの範囲とヨーの正規化はシミュレーションと同じ', () => {
    const points = aimTrajectory(
      {
        actions: [
          { time: 0, action: { type: 'look', yaw: 190, pitch: 100 } },
        ],
      },
      { yaw: 0, pitch: 0 },
    );
    expect(points.at(-1)).toEqual({ time: DT, yaw: -170, pitch: 89 });
  });

  it('リコイルのオフセットを含まない（利用者の照準だけ）', () => {
    // fire を押しても照準の軌道は動かない。
    const points = aimTrajectory(
      {
        actions: [
          { time: 0, action: { type: 'fire', pressed: true } },
          { time: 0.5, action: { type: 'fire', pressed: false } },
        ],
      },
      { yaw: 0, pitch: 0 },
    );
    expect(points.every((p) => p.yaw === 0 && p.pitch === 0)).toBe(true);
  });
});
