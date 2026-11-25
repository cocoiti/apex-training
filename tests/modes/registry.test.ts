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
    result: () => ({ scored: false }),
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
    const base = [file('recoil/pattern.ts', mode('pattern', 10)), file('recoil/center.ts', mode('center', 30))];
    const before = buildModeList(base);
    const after = buildModeList([...base, file('recoil/new.ts', mode('new', 20))]);
    expect(before.map((m) => m.id)).toEqual(['pattern', 'center']);
    expect(after.map((m) => m.id)).toEqual(['pattern', 'new', 'center']);
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
  it('src/modes/ のファイルから集めたモードに、パターン観察とセンター維持がこの順で入る', () => {
    const ids = modes.map((m) => m.id);
    expect(ids).toContain('pattern');
    expect(ids).toContain('center');
    expect(ids.indexOf('pattern')).toBeLessThan(ids.indexOf('center'));
    expect(modes.find((m) => m.id === 'pattern')?.name).toBe('パターン観察');
    expect(modes.find((m) => m.id === 'center')?.name).toBe('センター維持');
  });

  it('パターン観察は採点せず、センター維持は採点する', () => {
    const context = {} as Parameters<TrainingMode['result']>[0];
    expect(modes.find((m) => m.id === 'pattern')?.result(context).scored).toBe(false);
    expect(modes.find((m) => m.id === 'center')?.result(context).scored).toBe(true);
  });
});
