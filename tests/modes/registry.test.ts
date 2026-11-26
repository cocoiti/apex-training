import { describe, expect, it } from 'vitest';
import { buildModeList, modes, type ModeModule } from '../../src/modes/registry';
import type { TrainingMode } from '../../src/modes/types';

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

describe('登録されたモード', () => {
  it('MODE-27: src/modes/ のファイルから集めたモードは反復練習だけ', () => {
    expect(modes.map((m) => [m.id, m.name])).toEqual([['ghost', '反復練習']]);
    expect(modes.map((m) => m.id)).not.toContain('center');
    expect(modes.map((m) => m.name)).not.toContain('センター維持');
    expect(modes.map((m) => m.name)).not.toContain('パターン観察');
    expect(modes.map((m) => m.name)).not.toContain('ゴースト追従');
  });
});
