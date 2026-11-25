// docs/spec/pad.md「パッド向けのガイド」の受け入れ条件（PAD-15・PAD-16・PAD-20）と、SPEC の文書の構成の QA の受け入れテスト。
// 公開された入口（stickPosition・lookRate・PadInput・固定ステップのループ・PracticeSession・RecordingInput・padTraceView・
// 武器とマップの JSON・docs/spec/ の文書）だけを使い、実装の内部には依存しない。
// 期待する値は SPEC の式（「スティックから視点の回転へ」「カーブの逆」「理想の補正速度」）からこのファイルで求める。
// 画面（PAD-17〜PAD-19）は pad-guide-browser-qa.acceptance.test.ts で確かめる。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import type { LookAction } from '../../src/input/actions';
import { PadInput, type GamepadLike } from '../../src/input/pad';
import { lookRate, stickPosition, type PadSettings } from '../../src/input/pad-curve';
import { InputQueue } from '../../src/input/queue';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession } from '../../src/modes/session';
import { Simulation } from '../../src/sim/simulation';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { loadWorld } from '../../src/sim/world';
import { padTraceView } from '../../src/ui/result-view';

const ROOT = resolve(__dirname, '../..');
const SPEC = join(ROOT, 'docs/spec');
const WEAPON_DIR = join(ROOT, 'src/data/weapons');

/** SPEC の値の設定（デッドゾーン・外側しきい値は %）。最大回転速度は SPEC の既定値。 */
const settings = (responseCurve: number, extra: Partial<PadSettings> = {}): PadSettings => ({
  deadzone: 10,
  outerThreshold: 2,
  responseCurve,
  yaw: 300,
  pitch: 260,
  adsYaw: 90,
  adsPitch: 78,
  ...extra,
});

/** SPEC「スティックから視点の回転へ」の式（x は右、y は上が正）。 */
function specLookRate(x: number, y: number, s: PadSettings, ads: boolean) {
  const d = s.deadzone / 100;
  const o = s.outerThreshold / 100;
  const m = Math.min(1, Math.hypot(x, y));
  if (m === 0) return { yaw: 0, pitch: 0 };
  const t = Math.min(1, Math.max(0, (m - d) / (1 - o - d)));
  const q = t ** (1 + s.responseCurve / 8);
  return { yaw: q * (x / m) * (ads ? s.adsYaw : s.yaw), pitch: q * (y / m) * (ads ? s.adsPitch : s.pitch) };
}

/** SPEC「カーブの逆」の式（x は右、y は上が正）。 */
function specStickPosition(rate: { yaw: number; pitch: number }, s: PadSettings, ads: boolean) {
  const maxYaw = ads ? s.adsYaw : s.yaw;
  const maxPitch = ads ? s.adsPitch : s.pitch;
  const u = maxYaw === 0 ? 0 : rate.yaw / maxYaw;
  const w = maxPitch === 0 ? 0 : rate.pitch / maxPitch;
  const len = Math.hypot(u, w);
  const q = Math.min(1, len);
  if (q === 0) return { x: 0, y: 0 };
  const d = s.deadzone / 100;
  const o = s.outerThreshold / 100;
  const t = q ** (1 / (1 + s.responseCurve / 8));
  const m = d + t * (1 - o - d);
  return { x: (u / len) * m, y: (w / len) * m };
}

function loadWeapon(file: string): WeaponData {
  const r = parseWeapon(JSON.parse(readFileSync(join(WEAPON_DIR, file), 'utf8')));
  if (!r.ok) throw new Error(`${file} を読み込めない: ${JSON.stringify(r.errors)}`);
  return r.weapon;
}
const WEAPON_FILES = readdirSync(WEAPON_DIR).filter((f) => f.endsWith('.json')).sort();

function rangeWorld() {
  const r = loadWorld(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
  if (!r.ok) throw new Error(`range を読み込めない: ${JSON.stringify(r.errors)}`);
  return r.world;
}

/** Gamepad API の形のパッド（右スティックは軸 2・3 で、上下は下が正。R2 はボタン 7、L2 はボタン 6）。 */
function pad(x: number, y: number, r2 = 0, l2 = 0): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
  buttons[6] = { value: l2, pressed: l2 >= 0.5 };
  buttons[7] = { value: r2, pressed: r2 >= 0.5 };
  return { connected: true, mapping: 'standard', axes: [0, 0, x, -y], buttons };
}

/** 最大回転速度より遅い回転速度の例（ヨー・ピッチ、最大回転速度に対する割合）。 */
const RATE_FRACTIONS: [number, number][] = [
  [0.25, 0],
  [-0.6, 0],
  [0, 0.3],
  [0, -0.9],
  [0.4, 0.5],
  [-0.2, -0.7],
  [0.05, 0.02],
  [0.7, -0.6],
];

describe('QA: パッド向けのガイド（PAD-15・PAD-16・PAD-20）', () => {
  describe('PAD-15: デッドゾーン 10%・外側しきい値 2% で、カーブの逆で直した位置を回転の式に通すと元の回転速度に戻る', () => {
    for (const curve of [0, 8]) {
      for (const ads of [false, true]) {
        it(`レスポンスカーブ ${curve}・${ads ? 'ADS 中' : '腰撃ち'}`, () => {
          const s = settings(curve);
          const maxYaw = ads ? s.adsYaw : s.yaw;
          const maxPitch = ads ? s.adsPitch : s.pitch;
          for (const [fy, fp] of RATE_FRACTIONS) {
            const rate = { yaw: fy * maxYaw, pitch: fp * maxPitch };
            expect(Math.hypot(fy, fp)).toBeLessThan(1);
            const pos = stickPosition(rate, s, ads);
            // 公開された式（lookRate）に通すと元に戻る。
            const back = lookRate(pos.x, pos.y, s, ads);
            expect(back.yaw, `${JSON.stringify(rate)} のヨー`).toBeCloseTo(rate.yaw, 6);
            expect(back.pitch, `${JSON.stringify(rate)} のピッチ`).toBeCloseTo(rate.pitch, 6);
            // SPEC の式で求めても元に戻る（lookRate と SPEC の式の両方で確かめる）。
            const spec = specLookRate(pos.x, pos.y, s, ads);
            expect(spec.yaw).toBeCloseTo(rate.yaw, 6);
            expect(spec.pitch).toBeCloseTo(rate.pitch, 6);
            // SPEC「カーブの逆」の式の位置と同じ。
            const expected = specStickPosition(rate, s, ads);
            expect(pos.x).toBeCloseTo(expected.x, 9);
            expect(pos.y).toBeCloseTo(expected.y, 9);
          }
        });
      }
    }

    for (const curve of [0, 8]) {
      for (const ads of [false, true]) {
        it(`レスポンスカーブ ${curve}・${ads ? 'ADS 中（L2 を押したまま）' : '腰撃ち'}: パッドのスティックをその位置に 1 秒倒すと、回転量が回転速度 × 1 秒になる`, () => {
          const s = settings(curve);
          const maxYaw = ads ? s.adsYaw : s.yaw;
          const maxPitch = ads ? s.adsPitch : s.pitch;
          for (const [fy, fp] of [[0.4, 0.5], [-0.3, 0], [0, -0.45]] as [number, number][]) {
            const rate = { yaw: fy * maxYaw, pitch: fp * maxPitch };
            const pos = stickPosition(rate, s, ads);
            const world = rangeWorld();
            const queue = new InputQueue();
            const sim = new Simulation(world, queue);
            const time = new ManualTimeSource();
            const looks: LookAction[] = [];
            const input = new PadInput({ emit: (a) => queue.push(loop.currentTime(), a), settings: () => s });
            const loop = new FixedStepLoop({
              timeSource: time,
              update: () => {
                const look = input.step(sim.dt);
                if (look) {
                  looks.push(look);
                  queue.push(sim.time, look);
                }
                sim.step();
              },
              render: () => {},
            });
            const state = pad(pos.x, pos.y, 0, ads ? 1 : 0);
            input.poll(state);
            loop.frame();
            for (let i = 0; i < 60; i += 1) {
              time.advance(1 / 60);
              input.poll(state);
              loop.frame();
            }
            const seconds = sim.stepCount * sim.dt;
            expect(seconds).toBeCloseTo(1, 6);
            const total = looks.reduce((acc, a) => ({ yaw: acc.yaw + a.yaw, pitch: acc.pitch + a.pitch }), { yaw: 0, pitch: 0 });
            expect(total.yaw, `${JSON.stringify(rate)} のヨー`).toBeCloseTo(rate.yaw * seconds, 4);
            expect(total.pitch, `${JSON.stringify(rate)} のピッチ`).toBeCloseTo(rate.pitch * seconds, 4);
          }
        });
      }
    }
  });

  describe('PAD-16: デッドゾーン 10%・外側しきい値 2%・レスポンスカーブ 8・ヨー速度 300', () => {
    const s = settings(8, { yaw: 300 });
    it('右向きのヨー速度 75 度/秒をカーブの逆で直すと、右に 54%（上下は 0）', () => {
      const pos = stickPosition({ yaw: 75, pitch: 0 }, s, false);
      expect(pos.x).toBeCloseTo(0.54, 9);
      expect(Math.abs(pos.y)).toBeLessThan(1e-12);
    });
    it('回転速度 0 を直すと中心', () => {
      const pos = stickPosition({ yaw: 0, pitch: 0 }, s, false);
      expect(Math.abs(pos.x)).toBe(0);
      expect(Math.abs(pos.y)).toBe(0);
      const adsPos = stickPosition({ yaw: 0, pitch: 0 }, s, true);
      expect(Math.abs(adsPos.x)).toBe(0);
      expect(Math.abs(adsPos.y)).toBe(0);
    });
  });

  describe('PAD-20: リニアの設定で理想の位置にスティックを倒して記録すると、入力推移のグラフの自分と理想が一致する', () => {
    const linear = settings(0);
    const ghostMode = modes.find((m) => m.name === 'ゴースト追従');

    /** 理想の補正速度（SPEC「理想の補正速度」）。次に撃つ弾が k 発目（k ≥ 2）なら −pattern[k−1] × rpm ÷ 60。 */
    function specIdealRate(weapon: WeaponData, fire: boolean, nextShot: number, ammo: number) {
      if (!fire || nextShot < 2 || ammo <= 0) return { yaw: 0, pitch: 0 };
      const p = weapon.pattern[nextShot - 1]!;
      return { yaw: (-p.dx * weapon.rpm) / 60, pitch: (-p.dy * weapon.rpm) / 60 };
    }

    for (const file of WEAPON_FILES) {
      it(file, () => {
        expect(ghostMode, 'ゴースト追従のモードがある').toBeDefined();
        const weapon = loadWeapon(file);
        const world = rangeWorld();
        const recording = new RecordingInput(12345);
        const session = new PracticeSession({
          world,
          weapon,
          mode: ghostMode!,
          input: recording,
          seed: recording.seed,
          inputMethod: () => 'pad',
          padName: () => 'QA pad',
        });
        const dt = session.sim.dt;
        let fire = false;
        const input = new PadInput({
          emit: (a) => {
            if (a.type === 'fire') fire = a.pressed;
            recording.push(session.elapsed, a);
          },
          settings: () => linear,
        });
        // 少し待ってから R2 を押し続け、撃ち切ってリザルトになるまで、各ステップで理想の位置にスティックを倒す。
        let stepIndex = 0;
        let nonzero = 0;
        while (!session.ended && stepIndex < 60 * 30) {
          const r2 = stepIndex >= 10 ? 1 : 0;
          const ideal = specIdealRate(weapon, fire || r2 === 1, session.gun.nextPatternShot, session.gun.ammo);
          const pos = stickPosition(ideal, linear, false);
          if (pos.x !== 0 || pos.y !== 0) nonzero += 1;
          input.poll(pad(pos.x, pos.y, r2));
          const look = input.step(dt);
          if (look) recording.push(session.elapsed, look);
          session.step();
          stepIndex += 1;
        }
        expect(session.ended, '撃ち切って練習が終わる').toBe(true);
        expect(nonzero, '理想の位置にスティックを倒したステップがある').toBeGreaterThan(0);
        const view = padTraceView({ recording: recording.recording(), dt, padSettings: linear, result: { weapon, padName: 'QA pad' } });
        expect(view.title).toContain('QA pad');
        expect(view.plots).toHaveLength(2);
        for (const plot of view.plots) {
          expect(plot.series, `${plot.title} は自分と理想の 2 つの推移`).toHaveLength(2);
          const [a, b] = plot.series as [typeof plot.series[0], typeof plot.series[0]];
          expect(a.points.length).toBeGreaterThan(0);
          expect(a.points.length).toBe(b.points.length);
          for (let i = 0; i < a.points.length; i += 1) {
            expect(a.points[i]!.time).toBeCloseTo(b.points[i]!.time, 9);
            expect(a.points[i]!.value, `${plot.title} の ${i} 番目（${a.points[i]!.time} 秒）`).toBeCloseTo(b.points[i]!.value, 6);
          }
        }
        const movedTotal = view.plots.flatMap((p) => p.series.flatMap((s) => s.points)).filter((p) => Math.abs(p.value) > 1e-6).length;
        expect(movedTotal, '推移が 0 だけではない').toBeGreaterThan(0);
      });
    }
  });
});

// ---------------------------------------------------------------------------

/** 見出し（# の数と文言）で区切った節の本文。 */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)![0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

describe('QA: SPEC の文書（パッド向けのガイド）', () => {
  const padMd = readFileSync(join(SPEC, 'pad.md'), 'utf8');
  const scoringMd = readFileSync(join(SPEC, 'scoring.md'), 'utf8');
  const modesMd = readFileSync(join(SPEC, 'modes.md'), 'utf8');

  it('pad.md「パッド向けのガイド」が、理想の補正速度・カーブの逆・練習中のガイド・リザルトの入力推移のグラフの小見出しに分かれている', () => {
    const guide = section(padMd, '### パッド向けのガイド');
    expect(guide).not.toBe('');
    const subs = guide.split('\n').filter((l) => /^####\s/.test(l)).map((l) => l.replace(/^####\s+/, '').trim());
    expect(subs).toEqual(['理想の補正速度', 'カーブの逆', '練習中のガイド', 'リザルトの入力推移のグラフ']);
    for (const sub of subs) expect(section(padMd, `#### ${sub}`).trim().length, `${sub} に本文がある`).toBeGreaterThan(0);
  });

  it('scoring.md「リザルト画面」に pad.md への参照が 1 行ある', () => {
    const heading = scoringMd.split('\n').find((l) => /^#+\s+リザルト画面\s*$/.test(l));
    expect(heading, 'リザルト画面の見出しがある').toBeDefined();
    const body = section(scoringMd, heading!.trim());
    expect(body.split('\n').filter((l) => l.includes('(pad.md'))).toHaveLength(1);
  });

  it('modes.md「ゴースト追従」に pad.md への参照が 1 行ある', () => {
    const heading = modesMd.split('\n').find((l) => /^#+\s+ゴースト追従\s*$/.test(l));
    expect(heading, 'ゴースト追従の見出しがある').toBeDefined();
    const body = section(modesMd, heading!.trim());
    expect(body.split('\n').filter((l) => l.includes('(pad.md'))).toHaveLength(1);
  });
});
