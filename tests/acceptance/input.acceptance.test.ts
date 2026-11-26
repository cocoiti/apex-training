// docs/spec/input.md の受け入れ条件（INP-4 〜 INP-8）と architecture.md の ARC-2・ARC-3 の受け入れテスト。
// 公開された入口（公開関数・クラス、武器とマップの JSON、index.html と src/ のソース）だけを使い、実装の内部には依存しない。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import range from '../../src/data/maps/range.json';
import r99 from '../../src/data/weapons/r99.json';
import lstar from '../../src/data/weapons/lstar.json';
import { FixedStepLoop } from '../../src/core/loop';
import { createRandom } from '../../src/core/random';
import { ManualTimeSource } from '../../src/core/time';
import type { Action, TimedAction } from '../../src/input/actions';
import { RecordingInput, replayInput, type InputRecording } from '../../src/input/recording';
import { Gun } from '../../src/sim/gun';
import { parseMap, type MapData } from '../../src/sim/map';
import { createPractice, practiceOutcome, replayRecording, type Practice } from '../../src/sim/practice';
import { Simulation } from '../../src/sim/simulation';
import { aimTrajectory } from '../../src/sim/trajectory';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld } from '../../src/sim/world';

const ROOT = resolve(__dirname, '../..');
const TARGET_RADIUS = 1;

function rangeMap(): MapData {
  const result = parseMap(range);
  if (!result.ok) throw new Error(`range を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.map;
}

function weaponOf(json: unknown): WeaponData {
  const result = parseWeapon(json);
  if (!result.ok) throw new Error(`武器を読み込めない: ${JSON.stringify(result.errors)}`);
  return result.weapon;
}

/**
 * 利用者の練習を模す。hz の描画間隔でループを回し、描画の合間に時刻 at のアクションをループの時計の時刻で積む。
 * 0.05 秒に fire を押し、撃ちながら下へ引き、ads を切り替え、1.6 秒に離す。
 */
function practise(weapon: WeaponData, seed: number, hz = 60) {
  const map = rangeMap();
  const input = new RecordingInput(seed);
  const practice = createPractice({ map, weapon, input, seed: input.seed });
  const time = new ManualTimeSource();
  const loop = new FixedStepLoop({ timeSource: time, update: () => practice.sim.step(), render: () => {} });
  const pushed: TimedAction[] = [];
  const plan: { at: number; action: Action }[] = [
    { at: 0.05, action: { type: 'fire', pressed: true } },
    { at: 0.3, action: { type: 'ads', pressed: true } },
    { at: 1.0, action: { type: 'ads', pressed: false } },
    { at: 1.6, action: { type: 'fire', pressed: false } },
  ];
  for (let i = 0; i < 40; i += 1) plan.push({ at: 0.1 + i * 0.037, action: { type: 'look', yaw: (i % 5) * 0.03 - 0.06, pitch: -0.12 } });
  plan.sort((a, b) => a.at - b.at);
  const frames = Math.round(2.5 * hz);
  for (let f = 0; f < frames; f += 1) {
    time.advance(1 / hz);
    while (plan.length > 0 && plan[0]!.at <= time.now()) {
      const { action } = plan.shift()!;
      const at = loop.currentTime();
      input.push(at, action);
      pushed.push({ time: at, action });
    }
    loop.frame();
  }
  return { practice, recording: input.recording(), pushed, map };
}

const positions = (practice: Pick<Practice, 'gun'>) => practice.gun.shots.map((s) => s.position);

/** 記録を hz の描画間隔のループで再生する。 */
function replayAt(recording: InputRecording, weapon: WeaponData, hz: number) {
  const practice = createPractice({ map: rangeMap(), weapon, input: replayInput(recording), seed: recording.seed });
  const time = new ManualTimeSource();
  const loop = new FixedStepLoop({ timeSource: time, update: () => practice.sim.step(), render: () => {} });
  for (let f = 0; f < Math.round(3 * hz); f += 1) {
    time.advance(1 / hz);
    loop.frame();
  }
  return practice;
}

describe.each([
  ['R-99', r99],
  ['L-STAR', lstar],
])('入力の記録と再生（%s）', (_name, json) => {
  const weapon = weaponOf(json);

  it('前提: randomness が 0 でなく、練習で弾が当たっている', () => {
    expect(weapon.randomness).toBeGreaterThan(0);
    const { practice } = practise(weapon, 12345);
    expect(practice.gun.shots.length).toBeGreaterThan(5);
    expect(practice.gun.shots.every((s) => s.position !== null)).toBe(true);
  });

  it('INP-4: 練習した入力の記録を同じ武器・マップで再生すると、弾痕の位置と採点結果が元の練習と一致する', () => {
    const { practice, recording, map } = practise(weapon, 12345);
    const original = practiceOutcome(practice, TARGET_RADIUS);
    const replayed = replayRecording(recording, { map, weapon, targetRadius: TARGET_RADIUS });
    expect(replayed.shots.map((s) => s.position)).toEqual(positions(practice));
    expect(replayed.score).toEqual(original.score);
  });

  it('INP-5: 同じ入力の記録の種だけを変えて再生すると、弾痕の位置が元の練習と一致しない', () => {
    const { practice, recording, map } = practise(weapon, 12345);
    const replayed = replayRecording({ ...recording, seed: 54321 }, { map, weapon, targetRadius: TARGET_RADIUS });
    expect(replayed.shots).toHaveLength(practice.gun.shots.length);
    expect(replayed.shots.map((s) => s.position)).not.toEqual(positions(practice));
  });

  it('ARC-2: 同じ入力の記録を 60Hz 相当と 144Hz 相当の描画間隔で与えると、弾痕の位置と採点結果が一致する', () => {
    const { recording } = practise(weapon, 777, 144);
    const at60 = replayAt(recording, weapon, 60);
    const at144 = replayAt(recording, weapon, 144);
    expect(at60.gun.shots.length).toBeGreaterThan(0);
    expect(positions(at60)).toEqual(positions(at144));
    expect(practiceOutcome(at60, TARGET_RADIUS).score).toEqual(practiceOutcome(at144, TARGET_RADIUS).score);
  });
});

describe('INP-6: 練習の記録', () => {
  it('look・fire・ads を積んで練習すると、記録の actions は積んだアクションと時刻を積んだ順にすべて含み、seed はその練習の乱数の種', () => {
    const weapon = weaponOf(r99);
    const seed = 2024;
    const { practice, recording, pushed, map } = practise(weapon, seed);
    expect(new Set(recording.actions.map((a) => a.action.type))).toEqual(new Set(['look', 'fire', 'ads']));
    expect(recording.actions).toEqual(pushed);
    expect(recording.seed).toBe(seed);
    expect(practice.seed).toBe(seed);

    // 種がその練習の乱数の種であること: 記録の種で作った乱数の Gun に同じ入力を与えると、同じブレの弾になる。
    const world = createWorld(map);
    const sim = new Simulation(world, replayInput(recording));
    const gun = new Gun(weapon, createRandom(recording.seed));
    sim.addStepHook((w, dt) => gun.step(w, dt));
    sim.advance(3);
    expect(gun.shots).toEqual(practice.gun.shots);
  });
});

describe('INP-7: 照準の軌道', () => {
  it('0.1 秒にヨー +10、0.2 秒にピッチ -5 の look の記録から照準の軌道を取り出す', () => {
    const recording: InputRecording = {
      seed: 1,
      actions: [
        { time: 0.1, action: { type: 'look', yaw: 10, pitch: 0 } },
        { time: 0.2, action: { type: 'look', yaw: 0, pitch: -5 } },
      ],
    };
    const points = aimTrajectory(recording, { yaw: 0, pitch: 0 });
    expect(points[0]).toEqual({ time: 0, yaw: 0, pitch: 0 });

    const before = points.filter((p) => p.time < 0.15).at(-1)!;
    const after = points.find((p) => p.time > 0.15)!;
    for (const p of [before, after]) {
      expect(p.yaw).toBeCloseTo(10, 9);
      expect(p.pitch).toBeCloseTo(0, 9);
    }

    const last = points.at(-1)!;
    expect(last.yaw).toBeCloseTo(10, 9);
    expect(last.pitch).toBeCloseTo(-5, 9);

    const step = points[1]!.time - points[0]!.time;
    expect(step).toBeGreaterThan(0);
    for (let i = 1; i < points.length; i += 1) expect(points[i]!.time - points[i - 1]!.time).toBeCloseTo(step, 9);
  });
});

describe('ARC-3: ブラウザなしで入力の記録だけから採点まで実行できる', () => {
  it('アクションの列と種だけを与えて、発射から弾痕・採点結果まで求まる', () => {
    expect(typeof window).toBe('undefined');
    const recording: InputRecording = {
      seed: 99,
      actions: [
        { time: 0, action: { type: 'fire', pressed: true } },
        { time: 0.5, action: { type: 'look', yaw: 0, pitch: -1 } },
      ],
    };
    const weapon = weaponOf(r99);
    const result = replayRecording(recording, { map: rangeMap(), weapon, targetRadius: TARGET_RADIUS });
    expect(result.shots).toHaveLength(weapon.magSize);
    expect(result.shots.every((s) => s.position !== null)).toBe(true);
    expect(result.score.shots).toBe(weapon.magSize);
    expect(result.score.meanDeviation).not.toBeNull();
  });
});

describe('INP-8: 入力の記録を外に出す操作がない', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  function screenHtml(name: string): string {
    // 画面の中に入れ子の section（#result-pad など）があるので、次の画面の section の手前までを 1 つの画面とする。
    const match = new RegExp(`<section[^>]*data-screen="${name}"[\\s\\S]*?(?=<section class="screen"|$)`).exec(html);
    if (!match) throw new Error(`画面 ${name} がない`);
    return match[0];
  }

  /** 結果のシェア（screens.md「結果のシェア」）の区画。渡すのは成績の要約の文だけで、入力の記録は渡さない（OVR-5, OVR-20）。 */
  const SHARE_BLOCK = /<div class="share" data-share>[\s\S]*?<\/textarea>\s*<\/div>/;

  it.each(['play', 'result'])('%s の画面に、保存・コピー・送信の操作がない（結果のシェアの区画を除く）', (name) => {
    const section = screenHtml(name).replace(SHARE_BLOCK, '');
    expect(section).not.toMatch(/\bdownload\b/i);
    expect(section).not.toMatch(/<form\b/i);
    expect(section).not.toMatch(/保存|コピー|送信|書き出|エクスポート|共有/);
    expect(section).not.toMatch(/export|copy|share|upload/i);
  });

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : /\.ts$/.test(entry) ? [path] : [];
    });
  }

  it('結果のシェアの区画は、リザルト画面の「結果をシェア」のボタンと「X に投稿」のリンクと表示の欄だけ', () => {
    const block = SHARE_BLOCK.exec(screenHtml('result'))?.[0] ?? '';
    expect(block).toContain('data-i18n="share.button"');
    expect(block).not.toMatch(/\bdownload\b|<form\b|<input\b/i);
    expect([...block.matchAll(/<(a|button|textarea)\b/g)].map((m) => m[1])).toEqual(['button', 'a', 'textarea']);
    expect(block).toMatch(/href="https:\/\/x\.com\/intent\/post"/);
    expect(block).toMatch(/<textarea[^>]*\breadonly\b/);
  });

  it('src/ のコードが、ファイルへの書き出し・クリップボード・外部への送信の API を使わない（シェアの文のコピーを除く）', () => {
    const forbidden = /navigator\.clipboard|\.clipboard\b|execCommand\(|sendBeacon|createObjectURL|\.download\s*=|XMLHttpRequest|WebSocket|method:\s*['"]POST/;
    const share = join(ROOT, 'src/ui/share.ts');
    for (const file of sourceFiles(join(ROOT, 'src')).filter((f) => f !== share)) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(forbidden);
    }
    // シェアの文のコピーは src/ui/share.ts だけが行い、クリップボードには writeText で文字列だけを渡す。
    const source = readFileSync(share, 'utf8');
    expect(source).not.toMatch(/execCommand\(|sendBeacon|createObjectURL|\.download\s*=|XMLHttpRequest|WebSocket|fetch\(|clipboard\.write\(/);
  });
});
