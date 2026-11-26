import { describe, expect, it } from 'vitest';
import { buildModeList, modes, type ModeModule } from '../../src/modes/registry';
import { modeUsesDirectionSound, modeUsesWeakSections, modeUsesWeapon, type TrainingMode } from '../../src/modes/types';

function mode(id: string, order: number, extra: Partial<TrainingMode> = {}): TrainingMode {
  return {
    id,
    name: id,
    category: 'recoil',
    order,
    setup() {},
    step: () => true,
    result: () => ({}),
    teardown() {},
    ...extra,
  };
}

const file = (path: string, value: unknown): ModeModule => ({ file: path, module: { default: value } });

describe('モードの一覧を作る', () => {
  it('並び順の順に並べ、同じ並び順ならファイルのパスの順にする', () => {
    const list = buildModeList([
      file('recoil/c.ts', mode('c', 20)),
      file('recoil/b.ts', mode('b', 10)),
      file('movement/a.ts', mode('a', 20)),
      file('combined/z.ts', mode('z', 5)),
    ]);
    expect(list.map((m) => m.id)).toEqual(['z', 'b', 'a', 'c']);
  });

  it('ファイルを 1 つ足すと、ほかを変えずに一覧に出る（MODE-5）', () => {
    const base = [file('recoil/ghost.ts', mode('ghost', 20))];
    const before = buildModeList(base);
    const after = buildModeList([...base, file('recoil/new.ts', mode('new', 25))]);
    const first = buildModeList([...base, file('recoil/new.ts', mode('new', 10))]);
    expect(before.map((m) => m.id)).toEqual(['ghost']);
    expect(after.map((m) => m.id)).toEqual(['ghost', 'new']);
    expect(first.map((m) => m.id)).toEqual(['new', 'ghost']);
  });

  it('default がモードの形でないファイルと、id が重なるファイルは外して出力し、ほかは残す', () => {
    const logs: string[] = [];
    const list = buildModeList(
      [
        file('recoil/a.ts', mode('a', 1)),
        file('recoil/b.ts', mode('a', 2)),
        file('recoil/c.ts', { id: 'c', name: 'c' }),
        file('recoil/d.ts', mode('d', 3, { category: 'unknown' as TrainingMode['category'] })),
        { file: 'recoil/e.ts', module: {} },
        file('recoil/f.ts', mode('f', 4)),
      ],
      (m) => logs.push(m),
    );
    expect(list.map((m) => m.id)).toEqual(['a', 'f']);
    expect(logs).toHaveLength(4);
    expect(logs[0]).toContain('recoil/b.ts');
    expect(logs[0]).toContain('重複');
    expect(logs.slice(1).map((l) => l.match(/recoil\/\w\.ts/)?.[0])).toEqual(['recoil/c.ts', 'recoil/d.ts', 'recoil/e.ts']);
  });
});

describe('エイムのモードと採点の仕方', () => {
  const scoring = {
    compare: { id: 'hits', label: '命中数', unit: '', better: 'higher' as const, format: String },
    score: () => ({ value: 0, metrics: [] }),
  };

  it('種類 aim と、武器を使うか・制限時間・採点の仕方を持つモードを一覧に入れる', () => {
    const list = buildModeList([
      file('recoil/ghost.ts', mode('ghost', 20)),
      file('aim/flick.ts', mode('flick', 30, { category: 'aim', usesWeapon: false, timeLimit: 10, scoring })),
      file('aim/track.ts', mode('track', 10, { category: 'aim', usesWeapon: true, scoring: { ...scoring, columns: [scoring.compare] } })),
    ]);
    expect(list.map((m) => m.id)).toEqual(['track', 'ghost', 'flick']);
  });

  it.each([
    ['武器を使うかが真偽値でない', { usesWeapon: 'no' }],
    ['制限時間が 0', { timeLimit: 0 }],
    ['制限時間が数でない', { timeLimit: '10' }],
    ['採点の仕方に score がない', { scoring: { compare: scoring.compare } }],
    ['比べる指標の向きが不明', { scoring: { ...scoring, compare: { ...scoring.compare, better: 'up' } } }],
    ['比べる指標の項目名が保存の形の項目名', { scoring: { ...scoring, compare: { ...scoring.compare, id: 'version' } } }],
    ['比べる指標に書き方がない', { scoring: { ...scoring, compare: { id: 'hits', label: '命中数', unit: '', better: 'higher' } } }],
    ['一覧の指標の項目名が at', { scoring: { ...scoring, columns: [{ ...scoring.compare, id: 'at' }] } }],
  ])('%s モードは外す', (_, extra) => {
    const logs: string[] = [];
    const list = buildModeList([file('aim/x.ts', mode('x', 1, { category: 'aim', ...(extra as Partial<TrainingMode>) }))], (m) => logs.push(m));
    expect(list).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});

describe('登録されたモード', () => {
  it('MODE-27: src/modes/ のファイルから集めたモードは反復練習だけ', () => {
    expect(modes.map((m) => [m.id, m.name])).toEqual([['ghost', '反復練習']]);
    expect(modes.map((m) => m.id)).not.toContain('center');
    expect(modes.map((m) => m.name)).not.toContain('センター維持');
    expect(modes.map((m) => m.name)).not.toContain('パターン観察');
    expect(modes.map((m) => m.name)).not.toContain('ゴースト追従');
  });

  it('反復練習は武器を使い、弾痕のズレの採点・苦手な区間・向きの音・補正のパネルを使う', () => {
    const ghost = modes.find((m) => m.id === 'ghost')!;
    expect(modeUsesWeapon(ghost)).toBe(true);
    expect(ghost.scoring).toBeUndefined();
    expect(modeUsesWeakSections(ghost)).toBe(true);
    expect(modeUsesDirectionSound(ghost)).toBe(true);
    expect(ghost.correctionPanel).toBe('always');
    expect(ghost.timeLimit).toBeUndefined();
  });

  it('武器を使わないモードは向きの音を使わず、採点の仕方を持つモードは苦手な区間を使わない', () => {
    expect(modeUsesDirectionSound({ usesWeapon: false })).toBe(false);
    expect(modeUsesDirectionSound({ usesWeapon: true, directionSound: false })).toBe(false);
    expect(modeUsesWeakSections({ scoring: { compare: { id: 'x', label: 'x', unit: '', better: 'lower', format: String }, score: () => ({ value: null, metrics: [] }) } })).toBe(false);
    expect(modeUsesWeakSections({ weakSections: false })).toBe(false);
  });
});
