import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TimedAction } from '../../src/input/actions';
import { RecordingInput } from '../../src/input/recording';
import { modes } from '../../src/modes/registry';
import { PracticeSession, type PracticeResult } from '../../src/modes/session';
import type { TrainingMode } from '../../src/modes/types';
import type { ShotRecord } from '../../src/sim/gun';
import { parseMap } from '../../src/sim/map';
import { score } from '../../src/sim/scoring';
import { parseWeapon, type WeaponData } from '../../src/sim/weapon';
import { createWorld, type World } from '../../src/sim/world';
import { parsePersonalBest, personalBestKey } from '../../src/ui/personal-best';
import { completePractice, metricRows, renderResult, type FinishedPractice } from '../../src/ui/result-view';
import { SafeStorage } from '../../src/ui/storage';

const DATA = resolve(__dirname, '../../src/data');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(DATA, path), 'utf8'));

function loadWeapon(id: string): WeaponData {
  const parsed = parseWeapon(readJson(`weapons/${id}.json`));
  if (!parsed.ok) throw new Error(`武器 ${id} を読めない`);
  return parsed.weapon;
}

function rangeWorld(): World {
  const parsed = parseMap(readJson('maps/range.json'));
  if (!parsed.ok) throw new Error('マップを読めない');
  return createWorld(parsed.map);
}

/** センター維持と同じく採点するゴースト追従の代わり（ゴースト追従のモードはまだない）。 */
const ghostLike: TrainingMode = {
  id: 'ghost',
  name: 'ゴースト追従',
  category: 'recoil',
  order: 20,
  setup() {},
  step: () => true,
  result: () => ({ scored: true }),
  teardown() {},
};

function modeById(id: string): TrainingMode {
  if (id === 'ghost') return ghostLike;
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
const R301_CENTER = 'apex-training:best:mouse:r301:center';
const meanOf = (raw: string | undefined) => parsePersonalBest(raw ?? null)?.meanError;

describe('リザルト画面に出すもの', () => {
  it('SCO-16: センター維持では指標・コメント・自己ベストと、散布図と照準の軌道の重ね描きを出す', () => {
    const p = practice('r301', 'center');
    const view = completePractice(p, memoryStorage(), NOW);
    expect(view.scored).toBe(true);
    expect(view.summary).toBe(`R-301 / センター維持 — ${p.result.shots.length} 発`);
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

  it('SCO-16: ゴースト追従（採点するモード）でも同じものを出す', () => {
    const view = completePractice(practice('r301', 'ghost'), memoryStorage(), NOW);
    expect(view.scored).toBe(true);
    expect(view.plots.map((p) => p.name)).toEqual(['scatter', 'trajectory']);
  });

  it('SCO-17: パターン観察では指標・コメント・自己ベストを出さず、弾痕と補正しなかった場合のパターンを重ね、何も保存しない', () => {
    const storage = memoryStorage();
    const p = practice('r301', 'pattern', 0);
    const view = completePractice(p, storage, NOW);
    expect(view).toMatchObject({ scored: false, metrics: [], comments: [], best: null });
    expect(view.plots).toHaveLength(1);
    const [plot] = view.plots;
    expect(plot?.series.map((s) => s.name)).toEqual(['shots', 'pattern']);
    // 補正しなかったので、弾痕は補正しなかった場合のパターンから各発のブレ（randomness）の範囲に入る。
    const [shots, pattern] = plot?.series ?? [];
    expect(pattern?.points).toHaveLength(p.result.shots.length);
    shots?.points.forEach((s, i) => {
      expect(Math.abs(s.yaw - (pattern?.points[i]?.yaw ?? NaN))).toBeLessThanOrEqual(p.result.weapon.randomness + 1e-9);
      expect(Math.abs(s.pitch - (pattern?.points[i]?.pitch ?? NaN))).toBeLessThanOrEqual(p.result.weapon.randomness + 1e-9);
    });
    expect(storage.items.size).toBe(0);
  });

  it('SCO-18: 自己ベストがなければ「自己ベスト更新」を出し、マウス・R-301・センター維持のキーに平均ズレを保存する', () => {
    const storage = memoryStorage();
    const p = practice('r301', 'center');
    const view = completePractice(p, storage, NOW);
    expect(view.best).toBe('自己ベスト更新');
    expect([...storage.items.keys()]).toEqual([R301_CENTER]);
    const mean = score(
      p.result.shots.map((s) => s.deviation ?? { yaw: NaN, pitch: NaN }),
      1,
    ).meanDeviation;
    expect(meanOf(storage.items.get(R301_CENTER))).toBeCloseTo(mean ?? NaN, 9);
  });

  it('SCO-19: 保存してある自己ベストより平均ズレが大きいか等しいと、保存してある平均ズレを出し、値を変えない', () => {
    const p = practice('r301', 'center');
    const first = memoryStorage();
    completePractice(p, first, NOW);
    const saved = first.items.get(R301_CENTER) ?? '';
    // 等しい
    const equal = memoryStorage({ [R301_CENTER]: saved });
    const view = completePractice(p, equal, new Date('2026-12-01T00:00:00.000Z'));
    expect(view.best).not.toBe('自己ベスト更新');
    expect(view.best).toMatch(/^自己ベスト 平均ズレ \d+\.\d{2}°$/);
    expect(equal.items.get(R301_CENTER)).toBe(saved);
    // 大きい（保存してある自己ベストが 0 度）
    const better = JSON.stringify({ version: 1, meanError: 0, groupingRadius: 0, hitRate: 100, shots: 28, achievedAt: NOW.toISOString() });
    const larger = memoryStorage({ [R301_CENTER]: better });
    expect(completePractice(p, larger, NOW).best).toBe('自己ベスト 平均ズレ 0.00°');
    expect(larger.items.get(R301_CENTER)).toBe(better);
  });

  it('SCO-20: R-301 とセンター維持の自己ベストがあっても、別のモード・別の武器は初めてなら更新し、R-301 とセンター維持は変えない', () => {
    const best = JSON.stringify({ version: 1, meanError: 0, groupingRadius: 0, hitRate: 100, shots: 28, achievedAt: NOW.toISOString() });
    const storage = memoryStorage({ [R301_CENTER]: best });
    expect(completePractice(practice('r301', 'ghost'), storage, NOW).best).toBe('自己ベスト更新');
    expect(completePractice(practice('r99', 'center'), storage, NOW).best).toBe('自己ベスト更新');
    expect(storage.items.get(R301_CENTER)).toBe(best);
    expect(storage.items.has(personalBestKey('mouse', 'r301', 'ghost'))).toBe(true);
    expect(storage.items.has(personalBestKey('mouse', 'r99', 'center'))).toBe(true);
  });

  it('SCO-21: 自己ベストのキーに JSON として読めない値があっても、その結果を自己ベストとして保存する', () => {
    const storage = memoryStorage({ [R301_CENTER]: 'not json' });
    expect(completePractice(practice('r301', 'center'), storage, NOW).best).toBe('自己ベスト更新');
    expect(meanOf(storage.items.get(R301_CENTER))).toBeGreaterThan(0);
  });

  it('SCO-22: 書き込みが例外になる環境でも投げずに出すものを作り、保存できないことを知らせる', () => {
    const storage = new SafeStorage(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    let notified = false;
    storage.onUnavailable(() => {
      notified = true;
    });
    const view = completePractice(practice('r301', 'center'), storage, NOW);
    expect(view.best).toBe('自己ベスト更新');
    expect(notified).toBe(true);
  });

  it('弾が 1 発もない結果では、指標を「なし」と出し、図は空にする', () => {
    const p = practice('r301', 'center');
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
    score: { hidden: false },
    metrics: { innerHTML: '' },
    comments: { textContent: '' },
    best: { textContent: '' },
    plots: { innerHTML: '' },
  });

  it('採点するモードでは指標・コメント・自己ベスト・図を書き、採点しないモードでは指標の要素を隠す', () => {
    const e = elements();
    renderResult(e, completePractice(practice('r301', 'center'), memoryStorage(), NOW));
    expect(e.score.hidden).toBe(false);
    expect(e.metrics.innerHTML).toContain('<dt>平均ズレ</dt>');
    expect(e.best.textContent).toBe('自己ベスト更新');
    expect(e.plots.innerHTML).toContain('data-plot="scatter"');
    expect(e.plots.innerHTML).toContain('data-plot="trajectory"');

    renderResult(e, completePractice(practice('r301', 'pattern', 0), memoryStorage(), NOW));
    expect(e.score.hidden).toBe(true);
    expect(e.metrics.innerHTML).toBe('');
    expect(e.best.textContent).toBe('');
    expect(e.plots.innerHTML).toContain('data-plot="pattern"');
    expect(e.plots.innerHTML).not.toContain('data-plot="scatter"');
  });
});
