import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { PadInput, type GamepadLike } from '../../src/input/pad';
import { DEFAULT_PAD_SETTINGS, stickPosition, type PadSettings } from '../../src/input/pad-curve';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, type PracticeResult } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import type { ShotRecord } from '../../src/sim/gun';
import { parseMap, type MapData } from '../../src/sim/map';
import { replayRecording } from '../../src/sim/practice';
import { score, scoreShots, targetRadius } from '../../src/sim/scoring';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';
import { parsePersonalBest, personalBestKey } from '../../src/ui/personal-best';
import { historyKey, parseHistory } from '../../src/ui/practice-history';
import { completePractice, metricRows, padTraceView, renderResult, type FinishedPractice } from '../../src/ui/result-view';
import { SafeStorage } from '../../src/ui/storage';

const DATA = resolve(__dirname, '../../src/data');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(DATA, path), 'utf8'));

function loadWeapon(id: string): WeaponData {
  const parsed = parseWeapon(readJson(`weapons/${id}.json`));
  if (!parsed.ok) throw new Error(`武器 ${id} を読めない`);
  return parsed.weapon;
}

function rangeMap(): MapData {
  const parsed = parseMap(readJson('maps/range.json'));
  if (!parsed.ok) throw new Error('マップを読めない');
  return parsed.map;
}

function rangeWorld(): World {
  return createWorld(rangeMap());
}

function modeById(id: string): TrainingMode {
  const found = modes.find((m) => m.id === id);
  if (!found) throw new Error(`モード ${id} がない`);
  return found;
}

/** range のマップで、照準を毎ステップ少しずつ下げながら撃ち切る練習をして、リザルト画面に渡すものを返す。 */
function practice(weaponId: string, modeId: string, pullDown = 0.01): FinishedPractice {
  const world = rangeWorld();
  const weapon = loadWeapon(weaponId);
  const input = new RecordingInput(7);
  const session = new PracticeSession({ world, weapon, mode: modeById(modeId), input, seed: input.seed });
  input.push(0, { type: 'fire', pressed: true } as TimedAction['action']);
  for (let i = 0; i < 2000 && !session.ended; i += 1) {
    input.push(session.sim.time, { type: 'look', yaw: 0, pitch: -pullDown });
    session.step();
  }
  const result = session.result;
  if (!result) throw new Error('練習が終わらない');
  return { result, recording: input.recording(), world, input: 'mouse', dt: session.sim.dt };
}

/** practice と同じ練習の、種つきの入力の記録。 */
function practiceWithRecording(weaponId: string, modeId: string, pullDown: number) {
  const world = rangeWorld();
  const weapon = loadWeapon(weaponId);
  const input = new RecordingInput(7);
  const session = new PracticeSession({ world, weapon, mode: modeById(modeId), input, seed: input.seed });
  input.push(0, { type: 'fire', pressed: true } as TimedAction['action']);
  for (let i = 0; i < 2000 && !session.ended; i += 1) {
    input.push(session.sim.time, { type: 'look', yaw: 0, pitch: -pullDown });
    session.step();
  }
  const result = session.result;
  if (!result) throw new Error('練習が終わらない');
  const recording = input.recording();
  const finished: FinishedPractice = { result, recording, world, input: 'mouse', dt: session.sim.dt };
  return { finished, recording, weapon };
}

/** Map で代用した保存先。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get: (key: string) => items.get(key) ?? null,
    set: (key: string, value: string) => {
      items.set(key, value);
      return true;
    },
  };
}

const NOW = new Date('2026-11-25T00:00:00.000Z');
const LSTAR_GHOST = 'apex-training:best:mouse:lstar:ghost';
const meanOf = (raw: string | undefined) => parsePersonalBest(raw ?? null)?.meanError;

describe('リザルト画面に出すもの', () => {
  it('SCO-16: 反復練習では指標・コメント・自己ベストと、散布図と照準の軌道の重ね描きを出す', () => {
    const p = practice('lstar', 'ghost');
    const view = completePractice(p, memoryStorage(), NOW);
    expect(view.summary).toBe(`L-STAR / 反復練習 — ${p.result.shots.length} 発`);
    expect(view.metrics.map((m) => m.label)).toEqual(['平均ズレ', 'グルーピング半径', '命中率', '区間ごとのズレ', '横ブレ / 縦ブレ']);
    expect(view.comments.length).toBeGreaterThan(0);
    expect(view.best).toBe('自己ベスト更新');
    const [scatter, trajectory] = view.plots;
    expect(scatter?.name).toBe('scatter');
    expect(scatter?.circle).toBeCloseTo((Math.atan(0.3 / 9.9) * 180) / Math.PI, 9);
    expect(scatter?.series[0]?.points).toHaveLength(p.result.shots.length);
    expect(trajectory?.name).toBe('trajectory');
    expect(trajectory?.series.map((s) => [s.name, s.points.length])).toEqual([
      ['ideal', p.result.shots.length],
      ['aim', p.result.shots.length],
    ]);
  });

  it('SCO-18: 自己ベストがなければ「自己ベスト更新」を出し、マウス・L-STAR・反復練習のキーに平均ズレを保存する', () => {
    const storage = memoryStorage();
    const p = practice('lstar', 'ghost');
    const view = completePractice(p, storage, NOW);
    expect(view.best).toBe('自己ベスト更新');
    expect([...storage.items.keys()].filter((k) => k.startsWith('apex-training:best:'))).toEqual([LSTAR_GHOST]);
    // L-STAR は壁の外に外れる弾があるので、外れた弾も向きから中心とのズレを求める scoreShots で計算する。
    const mean = scoreShots(p.result.shots, p.world).meanDeviation;
    expect(meanOf(storage.items.get(LSTAR_GHOST))).toBeCloseTo(mean ?? NaN, 9);
  });

  it('SCO-19: 保存してある自己ベストより平均ズレが大きいか等しいと、保存してある平均ズレを出し、値を変えない', () => {
    const p = practice('lstar', 'ghost');
    const first = memoryStorage();
    completePractice(p, first, NOW);
    const saved = first.items.get(LSTAR_GHOST) ?? '';
    // 等しい
    const equal = memoryStorage({ [LSTAR_GHOST]: saved });
    const view = completePractice(p, equal, new Date('2026-12-01T00:00:00.000Z'));
    expect(view.best).not.toBe('自己ベスト更新');
    expect(view.best).toMatch(/^自己ベスト 平均ズレ \d+\.\d{2}°$/);
    expect(equal.items.get(LSTAR_GHOST)).toBe(saved);
    // 大きい（保存してある自己ベストが 0 度）
    const better = JSON.stringify({ version: 1, meanError: 0, groupingRadius: 0, hitRate: 100, shots: 28, achievedAt: NOW.toISOString() });
    const larger = memoryStorage({ [LSTAR_GHOST]: better });
    expect(completePractice(p, larger, NOW).best).toBe('自己ベスト 平均ズレ 0.00°');
    expect(larger.items.get(LSTAR_GHOST)).toBe(better);
  });

  it('SCO-20: マウスの L-STAR と反復練習の自己ベストがあっても、C.A.R. SMG・パッドは初めてなら更新し、マウスの L-STAR と反復練習は変えない', () => {
    const best = JSON.stringify({ version: 1, meanError: 0, groupingRadius: 0, hitRate: 100, shots: 28, achievedAt: NOW.toISOString() });
    const storage = memoryStorage({ [LSTAR_GHOST]: best });
    expect(completePractice(practice('car', 'ghost'), storage, NOW).best).toBe('自己ベスト更新');
    expect(completePractice({ ...practice('lstar', 'ghost'), input: 'pad' }, storage, NOW).best).toBe('自己ベスト更新');
    expect(storage.items.get(LSTAR_GHOST)).toBe(best);
    expect(storage.items.has(personalBestKey('mouse', 'car', 'ghost'))).toBe(true);
    expect(storage.items.has(personalBestKey('pad', 'lstar', 'ghost'))).toBe(true);
  });

  it('平均ズレと自己ベストを更新したかを出す', () => {
    const storage = memoryStorage();
    const first = completePractice(practice('lstar', 'ghost'), storage, NOW);
    expect(first.meanDeviation).toBeCloseTo(meanOf(storage.items.get(LSTAR_GHOST)) ?? NaN, 9);
    expect(first.bestUpdated).toBe(true);
    expect(completePractice(practice('lstar', 'ghost'), storage, NOW).bestUpdated).toBe(false);
  });

  it('命中率（%）を出す（シェアの文に使う）', () => {
    const p = practice('lstar', 'ghost');
    const view = completePractice(p, memoryStorage(), NOW);
    const world = rangeWorld();
    expect(view.hitRate).toBe(scoreShots(p.result.shots, world, targetRadius(world)).hitRate);
    expect(view.metrics.find((row) => row.label === '命中率')?.value).toBe(`${view.hitRate?.toFixed(1)}%`);
  });

  it('MODE-23: 連続練習で回ごとに採点すると、自己ベストには回のうち平均ズレが最も小さい回の平均ズレが残る', () => {
    const storage = memoryStorage();
    const means = [0.02, 0.005, 0.03, 0.01, 0.025].map((pullDown) => completePractice(practice('lstar', 'ghost', pullDown), storage, NOW).meanDeviation ?? NaN);
    expect(new Set(means).size).toBe(5);
    expect(meanOf(storage.items.get(LSTAR_GHOST))).toBeCloseTo(Math.min(...means), 9);
  });

  it('SCO-21: 自己ベストのキーに JSON として読めない値があっても、その結果を自己ベストとして保存する', () => {
    const storage = memoryStorage({ [LSTAR_GHOST]: 'not json' });
    expect(completePractice(practice('lstar', 'ghost'), storage, NOW).best).toBe('自己ベスト更新');
    expect(meanOf(storage.items.get(LSTAR_GHOST))).toBeGreaterThan(0);
  });

  it('SCO-22: 書き込みが例外になる環境でも投げずに出すものを作り、保存できないことを知らせる', () => {
    const storage = new SafeStorage(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    let notified = false;
    storage.onUnavailable(() => {
      notified = true;
    });
    const view = completePractice(practice('lstar', 'ghost'), storage, NOW);
    expect(view.best).toBe('自己ベスト更新');
    expect(notified).toBe(true);
  });

  it('弾が 1 発もない結果では、指標を「なし」と出し、図は空にする', () => {
    const p = practice('lstar', 'ghost');
    const empty: FinishedPractice = { ...p, result: { ...p.result, shots: [] as ShotRecord[] } as PracticeResult };
    const storage = memoryStorage();
    const view = completePractice(empty, storage, NOW);
    expect(view.metrics[0]).toEqual({ label: '平均ズレ', value: 'なし' });
    expect(view.comments).toEqual([]);
    expect(view.best).toBe('自己ベスト 平均ズレ なし');
    expect(view.plots.flatMap((plot) => plot.series.map((s) => s.points.length))).toEqual([0, 0, 0]);
    expect(storage.items.size).toBe(0);
  });
});

describe('練習の履歴の保存', () => {
  const LSTAR_GHOST_HISTORY = historyKey({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' });

  it('SCO-23: マウスで L-STAR と反復練習を 3 回終えると、3 件が古い順にその練習の指標と日時で保存される', () => {
    const storage = memoryStorage();
    const pulls = [0.01, 0.02, 0.005];
    const times = ['2026-11-25T01:00:00.000Z', '2026-11-25T02:00:00.000Z', '2026-11-25T03:00:00.000Z'];
    const views = pulls.map((pull, i) => completePractice(practice('lstar', 'ghost', pull), storage, new Date(times[i] ?? '')));
    expect(LSTAR_GHOST_HISTORY).toBe('apex-training:history:mouse:lstar:ghost');
    const stored = JSON.parse(storage.items.get(LSTAR_GHOST_HISTORY) ?? '') as { version: number; entries: unknown[] };
    expect(stored.version).toBe(1);
    const entries = parseHistory(storage.items.get(LSTAR_GHOST_HISTORY) ?? null);
    expect(entries.map((e) => e.at)).toEqual(times);
    pulls.forEach((pull, i) => {
      const p = practice('lstar', 'ghost', pull);
      const scored = scoreShots(p.result.shots, p.world);
      expect(entries[i]?.shots).toBe(p.result.shots.length);
      expect(entries[i]?.meanError).toBeCloseTo(scored.meanDeviation ?? NaN, 9);
      expect(entries[i]).toHaveProperty('hitRate');
      expect(entries[i]).toHaveProperty('groupingRadius');
      expect(views[i]?.metrics[0]?.value).toBe(`${entries[i]?.meanError.toFixed(2)}°`);
    });
  });

  it('SCO-26: C.A.R. SMG・パッドの練習では、マウスの L-STAR と反復練習の履歴を変えない', () => {
    const storage = memoryStorage();
    completePractice(practice('lstar', 'ghost'), storage, NOW);
    const saved = storage.items.get(LSTAR_GHOST_HISTORY);
    completePractice(practice('car', 'ghost'), storage, NOW);
    completePractice({ ...practice('lstar', 'ghost'), input: 'pad' }, storage, NOW);
    expect(storage.items.get(LSTAR_GHOST_HISTORY)).toBe(saved);
    expect(parseHistory(storage.items.get(historyKey({ input: 'mouse', weaponId: 'car', modeId: 'ghost' })) ?? null)).toHaveLength(1);
    expect(parseHistory(storage.items.get(historyKey({ input: 'pad', weaponId: 'lstar', modeId: 'ghost' })) ?? null)).toHaveLength(1);
  });

  it('SCO-29: 履歴のキーに JSON として読めない値があっても、その練習の 1 件だけの履歴にする', () => {
    const storage = memoryStorage({ [LSTAR_GHOST_HISTORY]: '{broken' });
    expect(completePractice(practice('lstar', 'ghost'), storage, NOW).meanDeviation).not.toBeNull();
    expect(parseHistory(storage.items.get(LSTAR_GHOST_HISTORY) ?? null)).toHaveLength(1);
  });
});

describe('苦手な区間の行', () => {
  const HISTORY = historyKey({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' });

  /** L-STAR と反復練習の練習の弾のズレを、11〜15 発目だけ水平 h 度、ほかの弾 0 にしたもの。 */
  const offAt11 = (h = 2): FinishedPractice => {
    const p = practice('lstar', 'ghost');
    const shots = p.result.shots.map((s, i) => ({ ...s, deviation: { yaw: i >= 10 && i < 15 ? h : 0, pitch: 0 } }));
    return { ...p, result: { ...p.result, shots } };
  };

  it('SCO-32: 11〜15 発目だけ右に 2 度ずれた練習を 5 回終えると、5 回目に「この武器の苦手な区間: 11〜15 発目、右に外しがち」', () => {
    const storage = memoryStorage();
    const views = Array.from({ length: 5 }, () => completePractice(offAt11(), storage, NOW));
    expect(views[4]?.weakSection).toBe('この武器の苦手な区間: 11〜15 発目、右に外しがち');
  });

  it('SCO-33: 同じ練習を 4 回だけ終えると、苦手な区間の行は出ない', () => {
    const storage = memoryStorage();
    const views = Array.from({ length: 4 }, () => completePractice(offAt11(), storage, NOW));
    expect(views.map((v) => v.weakSection)).toEqual([null, null, null, null]);
  });

  it('SCO-35: 直近 5 件のすべての発の区間のズレの大きさの平均が 0.5 度未満なら、苦手な区間の行は出ない', () => {
    const storage = memoryStorage();
    const views = Array.from({ length: 5 }, () => completePractice(offAt11(0.4), storage, NOW));
    expect(views[4]?.weakSection).toBeNull();
  });

  it('SCO-36: sections を持たない古い形式の件が 10 件ある組で 1 回終えても、行は出ず、履歴は 11 件で古い 10 件はそのまま', () => {
    const old = Array.from({ length: 10 }, (_, i) => ({ at: NOW.toISOString(), meanError: i, hitRate: 50, groupingRadius: 1, shots: 28 }));
    const storage = memoryStorage({ [HISTORY]: JSON.stringify({ version: 1, entries: old }) });
    const view = completePractice(offAt11(), storage, NOW);
    expect(view.weakSection).toBeNull();
    const saved = JSON.parse(storage.items.get(HISTORY) ?? '') as { entries: unknown[] };
    expect(saved.entries).toHaveLength(11);
    expect(saved.entries.slice(0, 10)).toEqual(old);
  });

  it('SCO-39: 以前のセンター維持のキーに苦手な区間の傾向がある 5 件があっても、反復練習を 1 回終えたときに行は出ず、そのキーは変わらない', () => {
    // 発の区間ごとのズレを持つ 5 件を作り、以前のセンター維持のキーに置く。
    const source = memoryStorage();
    Array.from({ length: 5 }, () => completePractice(offAt11(), source, NOW));
    const old = source.items.get(HISTORY) ?? '';
    expect(parseHistory(old).filter((e) => e.sections)).toHaveLength(5);
    const centerKey = historyKey({ input: 'mouse', weaponId: 'lstar', modeId: 'center' });
    expect(centerKey).toBe('apex-training:history:mouse:lstar:center');
    const storage = memoryStorage({ [centerKey]: old });
    const view = completePractice(offAt11(0), storage, NOW);
    expect(view.weakSection).toBeNull();
    expect(parseHistory(storage.items.get(HISTORY) ?? null)).toHaveLength(1);
    expect(storage.items.get(centerKey)).toBe(old);
  });

  it('行があれば書いて出し、なければ空にして隠す', () => {
    const storage = memoryStorage();
    const views = Array.from({ length: 5 }, () => completePractice(offAt11(), storage, NOW));
    const element = { textContent: '', hidden: true };
    const e = {
      summary: { textContent: '' },
      metrics: { innerHTML: '' },
      comments: { textContent: '' },
      best: { textContent: '' },
      weakSection: element,
      plots: { innerHTML: '' },
      padTrace: { innerHTML: '', hidden: true },
    };
    if (views[4]) renderResult(e, views[4]);
    expect(element).toEqual({ textContent: 'この武器の苦手な区間: 11〜15 発目、右に外しがち', hidden: false });
    if (views[0]) renderResult(e, views[0]);
    expect(element).toEqual({ textContent: '', hidden: true });
  });
});

describe('リザルト画面と再生の採点', () => {
  it('INP-4: 外れの弾を含む記録でも、リザルト画面の採点結果と、同じ記録を再生した採点結果が一致する', () => {
    // 照準を毎ステップ 0.5 度ずつ上げ、途中から的にも壁にも当たらない（空に向けて撃つ）。
    const { finished, recording, weapon } = practiceWithRecording('lstar', 'ghost', -0.5);
    const shots = finished.result.shots;
    expect(shots.some((s) => s.deviation === null)).toBe(true);
    expect(shots.some((s) => s.deviation !== null)).toBe(true);

    const storage = memoryStorage();
    const view = completePractice(finished, storage, NOW);
    const replayed = replayRecording(recording, { map: rangeMap(), weapon });
    expect(replayed.shots).toEqual(shots);
    expect(view.metrics).toEqual(metricRows(replayed.score));
    expect(view.comments).toEqual(replayed.score.comments);
    const saved = parsePersonalBest(storage.get(personalBestKey('mouse', 'lstar', 'ghost')));
    expect(saved?.meanError).toBe(replayed.score.meanDeviation);
  });
});

describe('指標の表示', () => {
  it('SCO-1: 全弾が中心なら平均ズレ 0・グルーピング半径 0・命中率 100%', () => {
    const rows = metricRows(score(Array.from({ length: 5 }, () => ({ yaw: 0, pitch: 0 })), 1));
    expect(rows.slice(0, 3).map((r) => r.value)).toEqual(['0.00°', '0.00°', '100.0%']);
  });

  it('「なし」の指標は「なし」と出す（区間・比）', () => {
    const rows = metricRows(score([{ yaw: 1, pitch: 0 }], 1));
    expect(rows[3]?.value).toBe('前半 なし / 中盤 なし / 後半 1.00°');
    expect(rows[4]?.value).toBe('1.00° / 0.00°（比 なし）');
  });
});

describe('リザルト画面の要素', () => {
  const elements = () => ({
    summary: { textContent: '' },
    metrics: { innerHTML: '' },
    comments: { textContent: '' },
    best: { textContent: '' },
    weakSection: { textContent: '', hidden: true },
    plots: { innerHTML: '' },
    padTrace: { innerHTML: '', hidden: true },
  });

  it('指標・コメント・自己ベスト・図を書く', () => {
    const e = elements();
    renderResult(e, completePractice(practice('lstar', 'ghost'), memoryStorage(), NOW));
    expect(e.metrics.innerHTML).toContain('<dt>平均ズレ</dt>');
    expect(e.best.textContent).toBe('自己ベスト更新');
    expect(e.plots.innerHTML).toContain('data-plot="scatter"');
    expect(e.plots.innerHTML).toContain('data-plot="trajectory"');
    expect(e.plots.innerHTML).not.toContain('data-plot="pattern"');
    expect(e.padTrace.hidden).toBe(true);
    expect(e.padTrace.innerHTML).toBe('');
  });

  it('PAD-19: 右スティックの入力推移のグラフは見出し（パッドの名前）と左右・上下の図を書き、ないときは隠す', () => {
    const e = elements();
    renderResult(e, completePractice(padPractice('ghost', 'DualSense Wireless Controller'), memoryStorage(), NOW));
    expect(e.padTrace.hidden).toBe(false);
    expect(e.padTrace.innerHTML).toContain('DualSense Wireless Controller');
    expect(e.padTrace.innerHTML).toContain('data-plot="stick-x"');
    expect(e.padTrace.innerHTML).toContain('data-plot="stick-y"');

    renderResult(e, completePractice(practice('lstar', 'ghost'), memoryStorage(), NOW));
    expect(e.padTrace.hidden).toBe(true);
    expect(e.padTrace.innerHTML).toBe('');
  });
});

const linearPad: PadSettings = { ...DEFAULT_PAD_SETTINGS, deadzone: 10, outerThreshold: 2, responseCurve: 0 };

/** 右スティックを (x, y)（上が正）に倒し、R2 を fire だけ押した標準配置のパッド。 */
function padState(x: number, y: number, fire: boolean): GamepadLike {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false }));
  buttons[7] = { value: fire ? 1 : 0, pressed: fire };
  return { connected: true, id: 'test-pad', mapping: 'standard', axes: [0, 0, x, 0 - y], buttons };
}

/**
 * パッドで練習する。各ステップでパッドを読み、右スティックを理想の補正速度をカーブの逆で直した位置（hold を渡したらその位置）に倒し、
 * パッドの look をそのステップの開始の時刻で積んでから進める（src/main.ts のループと同じ順）。
 */
function padPractice(modeId: string, padName: string | undefined, options: { hold?: { x: number; y: number }; settings?: PadSettings } = {}): FinishedPractice {
  const settings = options.settings ?? linearPad;
  const world = rangeWorld();
  const weapon = loadWeapon('lstar');
  const input = new RecordingInput(7);
  const session = new PracticeSession({
    world,
    weapon,
    mode: modeById(modeId),
    input,
    seed: input.seed,
    inputMethod: () => 'pad',
    padName: () => padName,
  });
  const pad = new PadInput({ emit: (action) => input.push(session.sim.time, action), settings: () => settings });
  for (let i = 0; i < 2000 && !session.ended; i += 1) {
    const target = options.hold ?? stickPosition(session.idealRate, settings, world.player.ads);
    pad.poll(padState(target.x, target.y, true));
    const look = pad.step(session.sim.dt);
    if (look) input.push(session.sim.time, look);
    session.step();
  }
  const result = session.result;
  if (!result) throw new Error('練習が終わらない');
  return { result, recording: input.recording(), world, input: 'pad', dt: session.sim.dt, padSettings: settings };
}

describe('右スティックの入力推移のグラフ', () => {
  it('PAD-19: パッドで反復練習を終えたとき、左右と上下の図にそれぞれ自分と理想の推移を出し、見出しにパッドの名前を出す', () => {
    const view = completePractice(padPractice('ghost', 'Xbox Wireless Controller'), memoryStorage(), NOW);
    expect(view.padTrace?.title).toContain('Xbox Wireless Controller');
    expect(view.padTrace?.plots.map((p) => p.name)).toEqual(['stick-x', 'stick-y']);
    for (const plot of view.padTrace?.plots ?? []) {
      expect(plot.series.map((s) => s.name)).toEqual(['ideal', 'stick']);
      expect(plot.series[0]?.points.length).toBeGreaterThan(0);
      expect(plot.series[0]?.points.length).toBe(plot.series[1]?.points.length);
    }
  });

  it('PAD-19: 名前が分からないパッドは「パッド」と出す', () => {
    const view = completePractice(padPractice('ghost', undefined), memoryStorage(), NOW);
    expect(view.padTrace?.title).toBe('右スティックの入力推移（パッド）');
  });

  it('PAD-19: マウスで終えたときは出さない', () => {
    expect(completePractice(practice('lstar', 'ghost'), memoryStorage(), NOW).padTrace).toBeNull();
  });

  it('PAD-20: リニアの設定で理想の位置に各ステップで倒した記録から作ると、自分の推移と理想の推移が一致する', () => {
    const p = padPractice('ghost', 'test-pad');
    const trace = padTraceView(p);
    for (const plot of trace.plots) {
      const [ideal, mine] = plot.series;
      expect(mine?.points.length).toBe(ideal?.points.length);
      mine?.points.forEach((point, i) => {
        expect(point.time).toBe(ideal?.points[i]?.time);
        expect(point.value).toBeCloseTo(ideal?.points[i]?.value ?? NaN, 9);
      });
    }
    // 撃っているあいだは理想の位置が中心でない（比べる値が 0 だけになっていない）。
    const pitch = trace.plots[1]?.series[0]?.points ?? [];
    expect(pitch.some((point) => point.value !== 0)).toBe(true);
  });

  it('スティックを右に倒したまま撃つと、自分の推移は左右がその位置、上下が中心のままで、理想の推移とずれる', () => {
    const trace = padTraceView(padPractice('ghost', 'test-pad', { hold: { x: 0.5, y: 0 } }));
    const [, mineX] = trace.plots[0]?.series ?? [];
    const [idealY, mineY] = trace.plots[1]?.series ?? [];
    expect(mineX?.points.length).toBeGreaterThan(1);
    mineX?.points.forEach((point) => expect(point.value).toBeCloseTo(0.5, 9));
    expect(mineY?.points.every((point) => point.value === 0)).toBe(true);
    expect(idealY?.points.some((point) => point.value !== 0)).toBe(true);
  });
});
