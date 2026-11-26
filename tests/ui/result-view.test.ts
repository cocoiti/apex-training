import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { PadInput, type GamepadLike } from '../../src/input/pad';
import { DEFAULT_PAD_SETTINGS, stickPosition, type PadSettings } from '../../src/input/pad-curve';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, replayPracticeSession, type PracticeResult } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import type { ShotRecord } from '../../src/sim/gun';
import { parseMap, type MapData } from '../../src/sim/map';
import { score, scoreShots, targetRadius } from '../../src/sim/scoring';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';
import { parsePersonalBest, personalBestKey } from '../../src/ui/personal-best';
import { historyKey, parseHistory } from '../../src/ui/practice-history';
import { commentText, completePractice, metricRows, padTraceView, renderResult, type FinishedPractice } from '../../src/ui/result-view';
import { inputFromTimedActions } from '../../src/input/queue';
import { anglesToPoint } from '../../src/sim/hit';
import { vec3 } from '../../src/sim/vec3';
import { aimMode, TARGET_SIZE } from '../helpers/aim-modes';
import flick, { type FlickRecord } from '../../src/modes/aim/flick';
import { modeOptionChoices } from '../../src/modes/types';
import { resultShare, resultShareText } from '../../src/ui/share';
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
    expect(first.value).toBeCloseTo(meanOf(storage.items.get(LSTAR_GHOST)) ?? NaN, 9);
    expect(first.bestUpdated).toBe(true);
    expect(completePractice(practice('lstar', 'ghost'), storage, NOW).bestUpdated).toBe(false);
  });

  it('シェアの文の 3 行目に平均ズレと命中率（%）を出す', () => {
    const p = practice('lstar', 'ghost');
    const view = completePractice(p, memoryStorage(), NOW);
    const world = rangeWorld();
    const scored = scoreShots(p.result.shots, world, targetRadius(world));
    const hitRate = view.metrics.find((row) => row.label === '命中率')?.value;
    expect(hitRate).toBe(`${scored.hitRate?.toFixed(1)}%`);
    expect(view.shareScore).toBe(`平均ズレ: ${scored.meanDeviation?.toFixed(2)}° / 命中率: ${hitRate}`);
  });

  it('MODE-23: 連続練習で回ごとに採点すると、自己ベストには回のうち平均ズレが最も小さい回の平均ズレが残る', () => {
    const storage = memoryStorage();
    const means = [0.02, 0.005, 0.03, 0.01, 0.025].map((pullDown) => completePractice(practice('lstar', 'ghost', pullDown), storage, NOW).value ?? NaN);
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
    expect(completePractice(practice('lstar', 'ghost'), storage, NOW).value).not.toBeNull();
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
    // 反復練習の人形（練習の的）も置くよう、同じモードで再生する。
    const session = replayPracticeSession(recording, { world: rangeWorld(), weapon, mode: modeById('ghost') });
    const replayed = { shots: session.shots, score: scoreShots(session.shots, session.world) };
    expect(replayed.shots).toEqual(shots);
    expect(view.metrics).toEqual(metricRows(replayed.score));
    expect(view.comments).toEqual(replayed.score.comments.map(commentText));
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

describe('モードごとの採点', () => {
  /** range のマップで、武器を使わない命中数のモードを練習する。的の中心に向けて hits 回、外へ向けて misses 回撃つ。 */
  function aimPractice(hits: number, misses = 0, weapon?: WeaponData): FinishedPractice {
    const world = rangeWorld();
    const center = vec3(0, 1.6, -6);
    const mode = aimMode({ id: 'flick', usesWeapon: weapon !== undefined, timeLimit: 3, targets: (c) => c.targets.add({ id: 't', size: TARGET_SIZE, position: center }) });
    const on = anglesToPoint(world.player.position, center);
    const start = world.player.aim;
    const actions: TimedAction[] = [{ time: 0, action: { type: 'look', yaw: on.yaw - start.yaw, pitch: on.pitch - start.pitch } }];
    let t = 0.1;
    for (let i = 0; i < hits; i += 1, t += 0.1) actions.push({ time: t, action: { type: 'fire', pressed: true } }, { time: t + 0.05, action: { type: 'fire', pressed: false } });
    actions.push({ time: t, action: { type: 'look', yaw: 20, pitch: 0 } });
    for (let i = 0; i < misses; i += 1) {
      t += 0.1;
      actions.push({ time: t, action: { type: 'fire', pressed: true } }, { time: t + 0.05, action: { type: 'fire', pressed: false } });
    }
    const session = new PracticeSession({ world, weapon, mode, input: inputFromTimedActions(actions), seed: 1 });
    while (!session.ended) session.step();
    return { result: session.result!, recording: { actions }, world, input: 'mouse', dt: session.sim.dt };
  }

  it('SCO-41: 弾痕のズレの採点と苦手な区間を使わないモードは、そのモードの指標と比べる指標の自己ベストを出し、平均ズレ・グルーピング半径・散布図・軌道・苦手な区間を出さない', () => {
    const storage = memoryStorage();
    const view = completePractice(aimPractice(3, 2), storage, NOW);
    expect(view.metrics).toEqual([
      { label: '命中数', value: '3' },
      { label: '撃った弾数', value: '5' },
    ]);
    expect(view.best).toBe('自己ベスト更新');
    expect(view.value).toBe(3);
    expect(view.plots).toEqual([]);
    expect(view.weakSection).toBeNull();
    expect(view.padTrace).toBeNull();
    expect(view.summary).toBe('エイムのテスト — 5 発');
    const labels = view.metrics.map((m) => m.label).join(' ');
    expect(labels).not.toMatch(/平均ズレ|グルーピング半径/);
    const again = completePractice(aimPractice(2), storage, NOW);
    expect(again.best).toBe('自己ベスト 命中数 3');
    expect(again.shareScore).toBe('命中数: 2');
  });

  it('SCO-42: 武器を使わないモードをマウスで終えると、自己ベストと履歴が - のキーに version 1 と比べる指標の値で保存される', () => {
    const storage = memoryStorage();
    completePractice(aimPractice(4), storage, NOW);
    const best = JSON.parse(storage.items.get('apex-training:best:mouse:-:flick') ?? '') as Record<string, unknown>;
    expect(best).toMatchObject({ version: 1, hits: 4 });
    const history = JSON.parse(storage.items.get('apex-training:history:mouse:-:flick') ?? '') as { version: number; entries: Record<string, unknown>[] };
    expect(history.version).toBe(1);
    expect(history.entries).toEqual([{ at: NOW.toISOString(), hits: 4, shots: 4 }]);
    expect([...storage.items.keys()].every((k) => k.includes(':-:flick'))).toBe(true);
  });

  it('武器を使うエイムのモードの保存のキーは武器の id で分ける', () => {
    const storage = memoryStorage();
    completePractice(aimPractice(1, 0, loadWeapon('lstar')), storage, NOW);
    expect(storage.items.has('apex-training:best:mouse:lstar:flick')).toBe(true);
    expect(storage.items.has('apex-training:history:mouse:lstar:flick')).toBe(true);
  });

  it('SCO-43: 反復練習の自己ベストと履歴の 1 件は、モードごとの採点を足す前と同じ項目を持つ', () => {
    const storage = memoryStorage();
    completePractice(practice('lstar', 'ghost'), storage, NOW);
    const best = JSON.parse(storage.items.get(LSTAR_GHOST) ?? '') as Record<string, unknown>;
    expect(Object.keys(best)).toEqual(['version', 'meanError', 'groupingRadius', 'hitRate', 'shots', 'achievedAt']);
    const history = JSON.parse(storage.items.get(historyKey({ input: 'mouse', weaponId: 'lstar', modeId: 'ghost' })) ?? '') as { entries: Record<string, unknown>[] };
    expect(Object.keys(history.entries[0] ?? {})).toEqual(['at', 'meanError', 'hitRate', 'groupingRadius', 'shots', 'sections']);
    const view = completePractice(practice('lstar', 'ghost'), storage, NOW);
    expect(view.metrics.map((m) => m.label)).toEqual(['平均ズレ', 'グルーピング半径', '命中率', '区間ごとのズレ', '横ブレ / 縦ブレ']);
    expect(view.plots.map((p) => p.name)).toEqual(['scatter', 'trajectory']);
    expect(view.best).toMatch(/^自己ベスト 平均ズレ \d+\.\d{2}°$/);
  });
});

describe('追いエイムのリザルト（docs/spec/scoring.md「追いエイムの採点」）', () => {
  const SPEEDS = { slow: '遅い', normal: 'ふつう', fast: '速い' } as const;

  /** 乗っていた割合が rate（%）になる、200 ステップの追いエイムの練習の結果。 */
  function trackingPractice(
    rate: number,
    options: { modeId?: 'tracking' | 'tracking-recoil'; speed?: keyof typeof SPEEDS; weapon?: WeaponData; shots?: ShotRecord[] } = {},
  ): FinishedPractice {
    const mode = modeById(options.modeId ?? 'tracking');
    const speed = options.speed ?? 'normal';
    const n = 200;
    const dt = 0.1;
    const steps = Array.from({ length: n }, (_, i) => ({ on: i < (rate / 100) * n, offAngle: i < (rate / 100) * n ? 0 : 1.5 }));
    const result: PracticeResult = {
      weapon: options.weapon,
      mode,
      shots: options.shots ?? [],
      endReason: 'time',
      inputMethod: 'mouse',
      padName: undefined,
      duration: n * dt,
      modeResult: { steps, reversals: [], dt },
      options: [{ id: speed, name: { ja: SPEEDS[speed], en: SPEEDS[speed] }, optionId: 'speed', label: { ja: '速さ', en: '速さ' } }],
    };
    return { result, recording: { actions: [] }, world: rangeWorld(), input: 'mouse', dt };
  }

  it('SCO-49: 乗っていた割合・外していたときのズレ・乗り直すまでの時間・速さ・自己ベストを出し、平均ズレ・グルーピング半径・散布図・軌道・苦手な区間を出さない', () => {
    const view = completePractice(trackingPractice(75), memoryStorage(), NOW);
    expect(view.metrics).toEqual([
      { label: '乗っていた割合', value: '75.0%' },
      { label: '外していたときのズレ', value: '1.50°' },
      { label: '乗り直すまでの時間', value: 'なし' },
      { label: '速さ', value: 'ふつう' },
    ]);
    expect(view.best).toBe('自己ベスト更新');
    expect(view.summary).toBe('追いエイム / 速さ: ふつう — 0 発');
    expect(view.plots).toEqual([]);
    expect(view.weakSection).toBeNull();
    expect(view.padTrace).toBeNull();
    expect(view.comments).toEqual([]);
    expect(view.metrics.map((m) => m.label).join(' ')).not.toMatch(/平均ズレ|グルーピング半径/);
    expect(view.shareScore).toBe('乗っていた割合: 75.0%');
  });

  it('SCO-50: マウス・ふつうで終えると、- と :normal のキーに version 1 と onTargetRate が保存される', () => {
    const storage = memoryStorage();
    completePractice(trackingPractice(42), storage, NOW);
    const best = JSON.parse(storage.items.get('apex-training:best:mouse:-:tracking:normal') ?? '') as Record<string, unknown>;
    expect(best).toEqual({ version: 1, onTargetRate: 42, offTargetError: 1.5, achievedAt: NOW.toISOString() });
    const history = JSON.parse(storage.items.get('apex-training:history:mouse:-:tracking:normal') ?? '') as { version: number; entries: unknown[] };
    expect(history).toEqual({ version: 1, entries: [{ at: NOW.toISOString(), onTargetRate: 42, offTargetError: 1.5 }] });
    expect([...storage.items.keys()].sort()).toEqual(['apex-training:best:mouse:-:tracking:normal', 'apex-training:history:mouse:-:tracking:normal']);
  });

  it('SCO-51: 60% の自己ベストがあると、60% と 55% では更新せず、65% で更新する', () => {
    const storage = memoryStorage();
    const key = 'apex-training:best:mouse:-:tracking:normal';
    completePractice(trackingPractice(60), storage, NOW);
    const same = completePractice(trackingPractice(60), storage, NOW);
    expect(same.bestUpdated).toBe(false);
    expect(same.best).toBe('自己ベスト 乗っていた割合 60.0%');
    expect(completePractice(trackingPractice(55), storage, NOW).bestUpdated).toBe(false);
    expect((JSON.parse(storage.items.get(key)!) as { onTargetRate: number }).onTargetRate).toBe(60);
    const better = completePractice(trackingPractice(65), storage, NOW);
    expect(better.best).toBe('自己ベスト更新');
    expect((JSON.parse(storage.items.get(key)!) as { onTargetRate: number }).onTargetRate).toBe(65);
  });

  it('SCO-52: 速さ・リコイルのあり / なし・武器で別のキーに保存し、追いエイムのふつうの自己ベストと履歴は変わらない', () => {
    const storage = memoryStorage();
    completePractice(trackingPractice(80), storage, NOW);
    const before = [storage.items.get('apex-training:best:mouse:-:tracking:normal'), storage.items.get('apex-training:history:mouse:-:tracking:normal')];
    const views = [
      completePractice(trackingPractice(30, { speed: 'fast' }), storage, NOW),
      completePractice(trackingPractice(30, { modeId: 'tracking-recoil', weapon: loadWeapon('lstar') }), storage, NOW),
      completePractice(trackingPractice(30, { modeId: 'tracking-recoil', weapon: loadWeapon('car') }), storage, NOW),
    ];
    expect(views.map((v) => v.best)).toEqual(['自己ベスト更新', '自己ベスト更新', '自己ベスト更新']);
    expect([storage.items.get('apex-training:best:mouse:-:tracking:normal'), storage.items.get('apex-training:history:mouse:-:tracking:normal')]).toEqual(before);
    for (const key of ['mouse:-:tracking:fast', 'mouse:lstar:tracking-recoil:normal', 'mouse:car:tracking-recoil:normal']) {
      expect(storage.items.has(`apex-training:best:${key}`)).toBe(true);
      expect(storage.items.has(`apex-training:history:${key}`)).toBe(true);
    }
  });

  it('SCO-53: 追いエイム＋リコイルでは、命中率と撃った弾数を出し、自己ベストと履歴に hitRate と shots を保存する', () => {
    const storage = memoryStorage();
    const shot = (n: number, target?: string): ShotRecord => ({ shot: n, patternShot: n, time: n * 0.1, angles: { yaw: 0, pitch: 0 }, position: null, deviation: null, ...(target ? { target } : {}) });
    const shots = [shot(1, 'tracking'), shot(2, 'tracking'), shot(3), shot(4, 'tracking')];
    const view = completePractice(trackingPractice(50, { modeId: 'tracking-recoil', weapon: loadWeapon('lstar'), shots }), storage, NOW);
    expect(view.metrics).toContainEqual({ label: '命中率', value: '75.0%' });
    expect(view.metrics).toContainEqual({ label: '撃った弾数', value: '4' });
    expect(view.summary).toBe('L-STAR / 追いエイム＋リコイル / 速さ: ふつう — 4 発');
    expect(JSON.parse(storage.items.get('apex-training:best:mouse:lstar:tracking-recoil:normal')!)).toMatchObject({ hitRate: 75, shots: 4 });
    const history = JSON.parse(storage.items.get('apex-training:history:mouse:lstar:tracking-recoil:normal')!) as { entries: Record<string, unknown>[] };
    expect(history.entries[0]).toMatchObject({ onTargetRate: 50, hitRate: 75, shots: 4 });
  });

  it('SCO-54: 追いエイム（リコイルなし）では、撃った弾があっても命中率と撃った弾数を出さない', () => {
    const shots: ShotRecord[] = [{ shot: 1, patternShot: 1, time: 0, angles: { yaw: 0, pitch: 0 }, position: null, deviation: null, target: 'tracking' }];
    const view = completePractice(trackingPractice(50, { shots }), memoryStorage(), NOW);
    expect(view.metrics.map((m) => m.label)).toEqual(['乗っていた割合', '外していたときのズレ', '乗り直すまでの時間', '速さ']);
  });
});

describe('フリックのリザルト（docs/spec/scoring.md「フリックの採点」）', () => {
  const FAR_SMALL = { 'flick-range': 'far', 'flick-size': 'small' };
  const BEST = 'apex-training:best:mouse:-:flick:far:small';
  const HISTORY = 'apex-training:history:mouse:-:flick:far:small';

  /** 撃った的の記録 targets のフリックの練習の結果。採点は記録だけから決まるので、練習を進めずに作る。 */
  function flickPractice(targets: readonly FlickRecord[], chosen: Record<string, string> = FAR_SMALL): FinishedPractice {
    const { id, name, category } = flick;
    const result: PracticeResult = {
      weapon: undefined,
      mode: { id, name, category, usesWeapon: false, scoring: flick.scoring! },
      shots: [],
      endReason: 'mode',
      inputMethod: 'mouse',
      padName: undefined,
      duration: 20,
      modeResult: { targets },
      options: modeOptionChoices(flick, chosen).map(({ option, choice }) => ({ ...choice, optionId: option.id, label: option.label })),
    };
    return { result, recording: { actions: [] }, world: rangeWorld(), input: 'mouse', dt: 1 / 120 };
  }
  /** 20 個すべて命中、時間がすべて time 秒の記録（命中 1 回あたりの時間 = time）。 */
  const allHit = (time: number): FlickRecord[] => Array.from({ length: 20 }, () => ({ time, hit: true, error: 0.2 }));

  it('SCO-57: 各指標・出る範囲・的の大きさ・自己ベストを出し、散布図・照準の軌道・平均ズレ・苦手な区間は出さない', () => {
    const records = Array.from({ length: 20 }, (_, i) => ({ time: 0.5, hit: i < 18, error: i < 18 ? 0.5 : 3 }));
    const view = completePractice(flickPractice(records), memoryStorage(), NOW);
    expect(view.metrics).toEqual([
      { label: '命中 1 回あたりの時間', value: '0.556 秒' },
      { label: '時間の平均', value: '0.500 秒' },
      { label: '命中率', value: '90.0%' },
      { label: '命中数', value: '18 / 20' },
      { label: 'ズレの平均', value: '0.75°' },
      { label: '出る範囲', value: '遠い' },
      { label: '的の大きさ', value: '小' },
    ]);
    expect(view.best).toBe('自己ベスト更新');
    expect(view.plots).toEqual([]);
    expect(view.weakSection).toBeNull();
    expect(view.padTrace).toBeNull();
    expect(view.summary).toBe('フリック / 出る範囲: 遠い / 的の大きさ: 小 — 0 発');
    expect(view.metrics.map((m) => m.label)).not.toContain('平均ズレ');
  });

  it('SCO-58: 自己ベストを -:flick:far:small に version 1 と 8 つの項目で保存し、履歴の最後の件に同じ結果を入れる', () => {
    const storage = memoryStorage();
    const records = Array.from({ length: 20 }, (_, i) => ({ time: 0.5, hit: i < 18, error: i < 18 ? 0.5 : 3 }));
    const view = completePractice(flickPractice(records), storage, NOW);
    expect(view.best).toBe('自己ベスト更新');
    const best = JSON.parse(storage.items.get(BEST) ?? '') as Record<string, unknown>;
    expect(Object.keys(best)).toEqual(['version', 'timePerHit', 'meanTime', 'hitRate', 'hits', 'targets', 'meanError', 'achievedAt']);
    expect(best).toMatchObject({ version: 1, meanTime: 0.5, hitRate: 90, hits: 18, targets: 20, meanError: 0.75, achievedAt: NOW.toISOString() });
    expect(best.timePerHit as number).toBeCloseTo(10 / 18, 12);
    const history = JSON.parse(storage.items.get(HISTORY) ?? '') as { version: number; entries: Record<string, unknown>[] };
    expect(history.version).toBe(1);
    const fields = Object.fromEntries(Object.entries(best).filter(([key]) => key !== 'version' && key !== 'achievedAt'));
    expect(history.entries.at(-1)).toEqual({ at: NOW.toISOString(), ...fields });
  });

  it('SCO-56: 1 個も命中しないと自己ベストも履歴も更新しない', () => {
    const storage = memoryStorage();
    const view = completePractice(flickPractice(Array.from({ length: 20 }, () => ({ time: 0.4, hit: false, error: 2 }))), storage, NOW);
    expect(view.value).toBeNull();
    expect(view.best).toBe('自己ベスト 命中 1 回あたりの時間 なし');
    expect(storage.items.has(BEST)).toBe(false);
    expect(storage.items.has(HISTORY)).toBe(false);
  });

  it('SCO-59: 0.6 秒の自己ベストは 0.5 秒で更新し、続く 0.5 秒（等しい）と 0.7 秒では更新しない', () => {
    const storage = memoryStorage({ [BEST]: JSON.stringify({ version: 1, timePerHit: 0.6, achievedAt: NOW.toISOString() }) });
    const timePerHit = () => (JSON.parse(storage.items.get(BEST) ?? '') as { timePerHit: number }).timePerHit;
    expect(completePractice(flickPractice(allHit(0.5)), storage, NOW).best).toBe('自己ベスト更新');
    expect(timePerHit()).toBeCloseTo(0.5, 12);
    expect(completePractice(flickPractice(allHit(0.5)), storage, NOW).best).toBe('自己ベスト 命中 1 回あたりの時間 0.500 秒');
    expect(completePractice(flickPractice(allHit(0.7)), storage, NOW).bestUpdated).toBe(false);
    expect(timePerHit()).toBeCloseTo(0.5, 12);
  });

  it('SCO-60: 出る範囲と的の大きさの組ごとに自己ベストと履歴を分け、ほかの組は変わらない', () => {
    const storage = memoryStorage();
    completePractice(flickPractice(allHit(0.5)), storage, NOW);
    const before = [storage.items.get(BEST), storage.items.get(HISTORY)];
    const view = completePractice(flickPractice(allHit(0.9), { 'flick-range': 'near', 'flick-size': 'large' }), storage, NOW);
    expect(view.best).toBe('自己ベスト更新');
    expect(storage.items.has('apex-training:best:mouse:-:flick:near:large')).toBe(true);
    expect(storage.items.has('apex-training:history:mouse:-:flick:near:large')).toBe(true);
    expect([storage.items.get(BEST), storage.items.get(HISTORY)]).toEqual(before);
  });

  it('UI-110: シェアの文の 2 行目は「モード: フリック / 出る範囲: 遠い / 的の大きさ: 小」、3 行目は命中 1 回あたりの時間と命中率', () => {
    const practiced = flickPractice(Array.from({ length: 20 }, (_, i) => ({ time: 0.5, hit: i < 18, error: 0.5 })));
    const view = completePractice(practiced, memoryStorage(), NOW);
    const lines = resultShareText(resultShare(practiced.result, view)).split('\n');
    expect(lines[1]).toBe('モード: フリック / 出る範囲: 遠い / 的の大きさ: 小');
    expect(lines[2]).toBe('命中 1 回あたりの時間: 0.556 秒 / 命中率: 90.0%');
  });
});
