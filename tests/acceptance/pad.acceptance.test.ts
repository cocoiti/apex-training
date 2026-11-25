// docs/spec/pad.md の受け入れ条件（PAD-4〜PAD-7、PAD-10〜PAD-14）の受け入れテスト。
// パッドの値を Gamepad API の形で与え、固定ステップのループとシミュレーションを通して照準の変化を確かめる。
import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { Action } from '../../src/input/actions';
import { isStandardMapping, PadInput, type GamepadLike } from '../../src/input/pad';
import { DEFAULT_PAD_SETTINGS, simpleToAdvanced, type PadSettings } from '../../src/input/pad-curve';
import { InputQueue } from '../../src/input/queue';
import { PITCH_LIMIT } from '../../src/sim/angles';
import { Simulation } from '../../src/sim/simulation';
import { loadWorld } from '../../src/sim/world';

function worldAtZero() {
  const result = loadWorld({
    id: 'acceptance',
    name: 'acceptance',
    spawn: { position: [0, 1.6, 0], yaw: 0, pitch: 0 },
    boxes: [{ id: 'w', kind: 'wall', center: [0, 0, -20], size: [1, 1, 1] }],
  });
  if (!result.ok) throw new Error(`マップを読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

/** 標準配置のパッド。axes は [左 x, 左 y, 右 x, 右 y]、y は下が正（Gamepad API のまま）。 */
function gamepad(state: { x?: number; y?: number; r2?: number; l2?: number; mapping?: string }): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
  buttons[6] = { value: state.l2 ?? 0, pressed: (state.l2 ?? 0) >= 0.5 };
  buttons[7] = { value: state.r2 ?? 0, pressed: (state.r2 ?? 0) >= 0.5 };
  return { connected: true, mapping: state.mapping ?? 'standard', axes: [0, 0, state.x ?? 0, state.y ?? 0], buttons };
}

/** main.ts と同じつなぎ方で、hz の描画間隔で seconds 秒パッドを保ったときの World と積んだ入力を返す。 */
function hold(state: Parameters<typeof gamepad>[0], settings: PadSettings, hz = 60, seconds = 1) {
  const world = worldAtZero();
  const input = new InputQueue();
  const sim = new Simulation(world, input);
  const time = new ManualTimeSource();
  const emitted: Action[] = [];
  const pad = new PadInput({
    emit: (action) => {
      emitted.push(action);
      input.push(loop.currentTime(), action);
    },
    settings: () => settings,
  });
  const loop = new FixedStepLoop({
    timeSource: time,
    update: () => {
      const look = pad.step(sim.dt);
      if (look) {
        emitted.push(look);
        input.push(sim.time, look);
      }
      sim.step();
    },
    render: () => {},
  });
  // 最初の描画で押した状態を読み、そこから seconds 秒保つ。
  pad.poll(gamepad(state));
  loop.frame();
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i += 1) {
    time.advance(1 / hz);
    pad.poll(gamepad(state));
    loop.frame();
  }
  const looks = emitted.filter((a) => a.type === 'look');
  const sum = looks.reduce((acc, a) => ({ yaw: acc.yaw + a.yaw, pitch: acc.pitch + a.pitch }), { yaw: 0, pitch: 0 });
  return { world, sim, emitted, sum };
}

const linear: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 0, outerThreshold: 0, responseCurve: 0 };

describe('パッドの受け入れ条件', () => {
  it('PAD-4: デッドゾーン 10% で傾き 8% のまま 1 秒保っても照準は動かない', () => {
    const { world } = hold({ x: 0.08 }, { ...DEFAULT_PAD_SETTINGS, deadzone: 10 });
    expect(world.player.aim).toEqual({ yaw: 0, pitch: 0 });
  });

  it('PAD-5: 傾き 50% で 1 秒倒し続けたとき、60Hz と 144Hz で回転量が同じ', () => {
    const at60 = hold({ x: 0.5 }, DEFAULT_PAD_SETTINGS, 60);
    const at144 = hold({ x: 0.5 }, DEFAULT_PAD_SETTINGS, 144);
    expect(at60.sim.stepCount).toBe(120);
    expect(at144.sim.stepCount).toBe(120);
    expect(at60.world.player.aim.yaw).toBeGreaterThan(0);
    expect(at144.world.player.aim.yaw).toBeCloseTo(at60.world.player.aim.yaw, 9);
  });

  it('PAD-6: リニア・ヨー速度 300 で右に倒し切って 1 秒保つと、ヨーが 300 度変わる', () => {
    const { sum } = hold({ x: 1 }, linear);
    expect(sum.yaw).toBeCloseTo(300, 9);
  });

  it('PAD-7: R2 が 0.4 では fire が出ず、0.6 では出る', () => {
    expect(hold({ r2: 0.4 }, linear).world.player.fire).toBe(false);
    const fired = hold({ r2: 0.6 }, linear);
    expect(fired.emitted).toContainEqual({ type: 'fire', pressed: true });
    expect(fired.world.player.fire).toBe(true);
  });

  it('PAD-10: 視点感度 2・ADS 感度 5・リニアの簡易設定は対応表の詳細設定になる', () => {
    expect(simpleToAdvanced({ look: 2, ads: 5, curve: 'linear' })).toEqual({
      yaw: 180,
      pitch: 156,
      adsYaw: 105,
      adsPitch: 91,
      responseCurve: 0,
      deadzone: 10,
      outerThreshold: 2,
    });
  });

  it('PAD-11: mapping が "standard" なら標準配置として扱い、空文字なら扱わない', () => {
    expect(isStandardMapping(gamepad({}))).toBe(true);
    expect(isStandardMapping(gamepad({ mapping: '' }))).toBe(false);
    expect(hold({ x: 1, r2: 1 }, linear).world.player.fire).toBe(true);
    const other = hold({ x: 1, r2: 1, mapping: '' }, linear);
    expect(other.emitted).toEqual([]);
    expect(other.world.player.aim).toEqual({ yaw: 0, pitch: 0 });
  });

  it('PAD-12: ピッチ速度 260 で上に倒し切って 1 秒保つと、look のピッチの合計は +260 度、照準は 89 度で止まる', () => {
    const { sum, world } = hold({ y: -1 }, linear);
    expect(sum.pitch).toBeCloseTo(260, 9);
    expect(world.player.aim.pitch).toBe(PITCH_LIMIT);
  });

  it('PAD-13: ADS ヨー速度 90 で L2 を押したまま右に倒し切って 1 秒保つと、ヨーが 90 度変わる', () => {
    const { world } = hold({ x: 1, l2: 1 }, linear);
    expect(world.player.ads).toBe(true);
    expect(world.player.aim.yaw).toBeCloseTo(90, 9);
  });

  it('PAD-14: デッドゾーン 10%・外側 2%・カーブ 8・ヨー速度 300 で右に 54% 倒して 1 秒保つと、ヨーが 75 度変わる', () => {
    const settings = { ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2, responseCurve: 8, yaw: 300 };
    const { world } = hold({ x: 0.54 }, settings);
    expect(world.player.aim.yaw).toBeCloseTo(75, 9);
  });
});
