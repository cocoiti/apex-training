// docs/spec/pad.md の受け入れ条件（PAD-4、PAD-5、PAD-7、PAD-10〜PAD-14）の QA の受け入れテスト。
// 公開された入口（PadInput・simpleToAdvanced・isStandardMapping・固定ステップのループ・Simulation）だけを使い、
// パッドの値を Gamepad API の形（axes の y は下が正）で与えて、出たアクションと照準の変化を SPEC の値と比べる。
import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { Action, LookAction } from '../../src/input/actions';
import { isStandardMapping, PadInput, type GamepadLike } from '../../src/input/pad';
import { DEFAULT_PAD_SETTINGS, simpleToAdvanced, type PadSettings } from '../../src/input/pad-curve';
import { InputQueue } from '../../src/input/queue';
import { Simulation } from '../../src/sim/simulation';
import { loadWorld } from '../../src/sim/world';

interface PadState {
  rx?: number;
  ry?: number;
  r2?: number;
  l2?: number;
  mapping?: string;
}

/** Gamepad API の形のパッド。標準配置では右スティックが軸 2・3、L2 がボタン 6、R2 がボタン 7。 */
function pad(state: PadState): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
  const l2 = state.l2 ?? 0;
  const r2 = state.r2 ?? 0;
  // pressed はブラウザによって閾値が違うので、アナログ値だけで判定されることを確かめるため常に false にする。
  buttons[6] = { value: l2, pressed: false };
  buttons[7] = { value: r2, pressed: false };
  return { connected: true, mapping: state.mapping ?? 'standard', axes: [0, 0, state.rx ?? 0, state.ry ?? 0], buttons };
}

function freshWorld() {
  const result = loadWorld({
    id: 'qa',
    name: 'qa',
    spawn: { position: [0, 1.6, 0], yaw: 0, pitch: 0 },
    boxes: [{ id: 'w', kind: 'wall', center: [0, 0, -30], size: [1, 1, 1] }],
  });
  if (!result.ok) throw new Error(`マップを読み込めない: ${JSON.stringify(result.errors)}`);
  return result.world;
}

/**
 * hz の描画間隔で、描画のたびに最新のパッドの値を読み、seconds 秒そのまま保つ。
 * 最初の描画（時刻 0）でパッドを読み、そこから経過時間を与える。
 */
function run(state: PadState, settings: PadSettings, hz: number, seconds = 1) {
  const world = freshWorld();
  const queue = new InputQueue();
  const sim = new Simulation(world, queue);
  const time = new ManualTimeSource();
  const actions: Action[] = [];
  const fireAtStep: boolean[] = [];
  const input = new PadInput({
    emit: (action) => {
      actions.push(action);
      queue.push(loop.currentTime(), action);
    },
    settings: () => settings,
  });
  const loop = new FixedStepLoop({
    timeSource: time,
    update: () => {
      const look = input.step(sim.dt);
      if (look) {
        actions.push(look);
        queue.push(sim.time, look);
      }
      sim.step();
      fireAtStep.push(world.player.fire);
    },
    render: () => {},
  });
  input.poll(pad(state));
  loop.frame();
  const frames = Math.round(hz * seconds);
  for (let i = 0; i < frames; i += 1) {
    time.advance(1 / hz);
    input.poll(pad(state));
    loop.frame();
  }
  const looks = actions.filter((a): a is LookAction => a.type === 'look');
  const total = looks.reduce((acc, a) => ({ yaw: acc.yaw + a.yaw, pitch: acc.pitch + a.pitch }), { yaw: 0, pitch: 0 });
  return { world, sim, actions, looks, total, fireAtStep };
}

const linear0: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 0, outerThreshold: 0, responseCurve: 0 };

describe('QA: パッドの受け入れ条件', () => {
  describe('PAD-4: デッドゾーン 10% で傾き 8% のまま 1 秒保っても照準は動かない', () => {
    for (const [label, rx, ry] of [
      ['右に 8%', 0.08, 0],
      ['上に 8%', 0, -0.08],
      ['斜めに 8%', 0.08 / Math.SQRT2, -0.08 / Math.SQRT2],
    ] as const) {
      it(label, () => {
        const settings = { ...DEFAULT_PAD_SETTINGS, deadzone: 10 };
        const { world, total, sim } = run({ rx, ry }, settings, 60);
        expect(sim.stepCount).toBe(120);
        expect(Math.abs(total.yaw)).toBe(0);
        expect(Math.abs(total.pitch)).toBe(0);
        expect(world.player.aim.yaw).toBe(0);
        expect(world.player.aim.pitch).toBe(0);
      });
    }
  });

  describe('PAD-5: 傾き 50% で 1 秒倒し続けたとき、60Hz と 144Hz で回転量が同じ', () => {
    for (const [label, rx, ry] of [
      ['右に 50%', 0.5, 0],
      ['上に 50%', 0, -0.5],
    ] as const) {
      it(label, () => {
        const a = run({ rx, ry }, DEFAULT_PAD_SETTINGS, 60);
        const b = run({ rx, ry }, DEFAULT_PAD_SETTINGS, 144);
        expect(a.sim.stepCount).toBe(b.sim.stepCount);
        const moved = Math.abs(a.world.player.aim.yaw) + Math.abs(a.world.player.aim.pitch);
        expect(moved).toBeGreaterThan(0);
        expect(b.world.player.aim.yaw).toBeCloseTo(a.world.player.aim.yaw, 9);
        expect(b.world.player.aim.pitch).toBeCloseTo(a.world.player.aim.pitch, 9);
        expect(b.total.yaw).toBeCloseTo(a.total.yaw, 9);
        expect(b.total.pitch).toBeCloseTo(a.total.pitch, 9);
      });
    }
  });

  describe('PAD-7: R2 が 0.4 では fire が出ず、0.6 では出る（しきい値 0.5）', () => {
    it('R2 = 0.4 では fire（押した）が出ず、射撃の状態にならない', () => {
      const { actions, fireAtStep } = run({ r2: 0.4 }, linear0, 60);
      expect(actions.filter((a) => a.type === 'fire' && a.pressed)).toEqual([]);
      expect(fireAtStep.every((f) => !f)).toBe(true);
    });

    it('R2 = 0.6 では fire（押した）が出て、射撃の状態になる', () => {
      const { actions, world } = run({ r2: 0.6 }, linear0, 60);
      expect(actions).toContainEqual({ type: 'fire', pressed: true });
      expect(world.player.fire).toBe(true);
    });
  });

  describe('PAD-10: 簡易設定は対応表のとおりの詳細設定になる', () => {
    it('例: 視点感度 2・ADS 感度 5・リニア', () => {
      const s = simpleToAdvanced({ look: 2, ads: 5, curve: 'linear' });
      expect(s.yaw).toBe(180);
      expect(s.pitch).toBe(156);
      expect(s.adsYaw).toBe(105);
      expect(s.adsPitch).toBe(91);
      expect(s.responseCurve).toBe(0);
      expect(s.deadzone).toBe(10);
      expect(s.outerThreshold).toBe(2);
    });

    const yaw = [120, 180, 240, 300, 360, 420];
    const pitch = [104, 156, 208, 260, 312, 364];
    const adsYaw = [45, 60, 75, 90, 105, 120];
    const adsPitch = [39, 52, 65, 78, 91, 104];
    for (let look = 1; look <= 6; look += 1) {
      for (let ads = 1; ads <= 6; ads += 1) {
        for (const curve of ['classic', 'linear'] as const) {
          it(`視点感度 ${look}・ADS 感度 ${ads}・${curve}`, () => {
            const s = simpleToAdvanced({ look, ads, curve });
            expect(s.yaw).toBe(yaw[look - 1]);
            expect(s.pitch).toBe(pitch[look - 1]);
            expect(s.adsYaw).toBe(adsYaw[ads - 1]);
            expect(s.adsPitch).toBe(adsPitch[ads - 1]);
            expect(s.responseCurve).toBe(curve === 'classic' ? 8 : 0);
            expect(s.deadzone).toBe(10);
            expect(s.outerThreshold).toBe(2);
          });
        }
      }
    }
  });

  describe('PAD-11: mapping が "standard" なら標準配置、空文字なら標準配置ではない', () => {
    it('isStandardMapping の判定', () => {
      expect(isStandardMapping({ mapping: 'standard' })).toBe(true);
      expect(isStandardMapping({ mapping: '' })).toBe(false);
    });

    it('"standard" のパッドは標準配置の右スティック・R2 で look と fire が出る', () => {
      const { total, world } = run({ rx: 1, r2: 1 }, linear0, 60);
      expect(total.yaw).toBeGreaterThan(0);
      expect(world.player.fire).toBe(true);
    });

    it('空文字のパッドは標準配置の割り当てで look も fire も出ない', () => {
      const { actions, world } = run({ rx: 1, r2: 1, mapping: '' }, linear0, 60);
      expect(actions.filter((a) => a.type === 'look' || (a.type === 'fire' && a.pressed))).toEqual([]);
      expect(world.player.aim).toEqual({ yaw: 0, pitch: 0 });
      expect(world.player.fire).toBe(false);
    });
  });

  describe('PAD-12: ピッチ速度 260 で上に倒し切って 1 秒保つと、look のピッチの合計が +260 度、照準は 89 度で止まる', () => {
    for (const hz of [60, 144]) {
      it(`${hz}Hz`, () => {
        const { total, world } = run({ ry: -1 }, { ...linear0, pitch: 260 }, hz);
        expect(total.pitch).toBeCloseTo(260, 6);
        expect(total.yaw).toBeCloseTo(0, 9);
        expect(world.player.aim.pitch).toBe(89);
      });
    }
  });

  describe('PAD-13: ADS ヨー速度 90 で L2 を押したまま右に倒し切って 1 秒保つと、ヨーが 90 度変わる', () => {
    for (const hz of [60, 144]) {
      it(`${hz}Hz`, () => {
        // 腰撃ちのヨー速度は既定の 300 のまま。ADS 中だけ 90 を使うことを確かめる。
        const { world, total } = run({ rx: 1, l2: 1 }, { ...linear0, yaw: 300, adsYaw: 90 }, hz);
        expect(world.player.ads).toBe(true);
        expect(total.yaw).toBeCloseTo(90, 6);
        expect(world.player.aim.yaw).toBeCloseTo(90, 6);
      });
    }
  });

  describe('PAD-14: デッドゾーン 10%・外側 2%・カーブ 8・ヨー速度 300 で右に 54% 倒して 1 秒保つと、ヨーが 75 度変わる', () => {
    for (const hz of [60, 144]) {
      it(`${hz}Hz`, () => {
        const settings = { ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2, responseCurve: 8, yaw: 300 };
        const { world, total } = run({ rx: 0.54 }, settings, hz);
        expect(total.yaw).toBeCloseTo(75, 6);
        expect(world.player.aim.yaw).toBeCloseTo(75, 6);
        expect(world.player.aim.pitch).toBeCloseTo(0, 9);
      });
    }
  });
});
