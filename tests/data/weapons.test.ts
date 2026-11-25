import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWeapons, reportRejectedWeapons, weaponUrls } from '../../src/data/weapons';

const WEAPONS_DIR = resolve(__dirname, '../../src/data/weapons');

function weapon(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    category: 'AR',
    version: 'S31-Cipher',
    source: '仮データ',
    rpm: 600,
    magSize: 1,
    pattern: [{ dx: 0, dy: 1 }],
    randomness: 0,
    ...extra,
  };
}

function withoutRpm(json: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...json };
  delete copy.rpm;
  return copy;
}

describe('武器の JSON の一覧と取得', () => {
  it('WPN-1: src/data/weapons/ のすべての JSON がファイル名の順に URL の一覧に入る', () => {
    const files = readdirSync(WEAPONS_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(weaponUrls.map((w) => w.file)).toEqual(files);
    for (const { url } of weaponUrls) expect(url).toMatch(/\.json/);
  });

  it('WPN-2: 取得した JSON のうち rpm が欠けたものは一覧から外れ、ファイル名と欠けた項目が出力され、ほかの武器は返る', async () => {
    const bodies: Record<string, unknown> = {
      'u/a': weapon('a'),
      'u/broken': withoutRpm(weapon('broken')),
      'u/b': weapon('b'),
    };
    const logs: string[] = [];
    const weapons = await loadWeapons({
      files: [
        { file: 'a.json', url: 'u/a' },
        { file: 'broken.json', url: 'u/broken' },
        { file: 'b.json', url: 'u/b' },
      ],
      fetchJson: (url) => Promise.resolve(bodies[url]),
      log: (m) => logs.push(m),
    });
    expect(weapons.map((w) => w.id)).toEqual(['a', 'b']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('broken.json');
    expect(logs[0]).toContain('rpm');
  });

  it('取得できない JSON は一覧から外れ、ファイル名が出力される', async () => {
    const logs: string[] = [];
    const weapons = await loadWeapons({
      files: [
        { file: 'a.json', url: 'u/a' },
        { file: 'gone.json', url: 'u/gone' },
      ],
      fetchJson: (url) => (url === 'u/a' ? Promise.resolve(weapon('a')) : Promise.reject(new Error('取得できない（404）'))),
      log: (m) => logs.push(m),
    });
    expect(weapons.map((w) => w.id)).toEqual(['a']);
    expect(logs).toEqual(['武器のデータ gone.json を読み込めないので一覧から外す: 取得できない（404）']);
  });

  it('WPN-12: 外した武器の出力にファイル名と pattern の誤りが入る', () => {
    const logs: string[] = [];
    reportRejectedWeapons([{ file: 'short.json', errors: [{ path: 'pattern', message: '要素数（1）が magSize（2）より少ない' }] }], (m) =>
      logs.push(m),
    );
    expect(logs).toEqual(['武器のデータ short.json を読み込めないので一覧から外す: pattern: 要素数（1）が magSize（2）より少ない']);
  });
});
