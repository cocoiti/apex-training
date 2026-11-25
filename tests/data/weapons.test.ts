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
    measured: true,
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

  it('WPN-21: measured が false の武器は返らず、誤りも出力されない。true にすると返る', async () => {
    const files = [
      { file: 'a.json', url: 'u/a' },
      { file: 'p.json', url: 'u/p' },
    ];
    const load = (measured: boolean, logs: string[]) =>
      loadWeapons({
        files,
        fetchJson: (url) => Promise.resolve(url === 'u/a' ? weapon('a') : weapon('p', { measured })),
        log: (m) => logs.push(m),
      });
    const logs: string[] = [];
    expect((await load(false, logs)).map((w) => w.id)).toEqual(['a']);
    expect(logs).toEqual([]);
    expect((await load(true, logs)).map((w) => w.id)).toEqual(['a', 'p']);
    expect(logs).toEqual([]);
  });

  it('WPN-22: measured が欠けた・真偽値でない武器は返らず、ファイル名と measured の誤りが出力される', async () => {
    const missing: Record<string, unknown> = weapon('missing');
    delete missing.measured;
    const bodies: Record<string, unknown> = { 'u/missing': missing, 'u/text': weapon('text', { measured: 'yes' }) };
    const logs: string[] = [];
    const weapons = await loadWeapons({
      files: [
        { file: 'missing.json', url: 'u/missing' },
        { file: 'text.json', url: 'u/text' },
      ],
      fetchJson: (url) => Promise.resolve(bodies[url]),
      log: (m) => logs.push(m),
    });
    expect(weapons).toEqual([]);
    expect(logs).toEqual([
      '武器のデータ missing.json を読み込めないので一覧から外す: measured: 必須の項目がない',
      '武器のデータ text.json を読み込めないので一覧から外す: measured: 真偽値ではない',
    ]);
  });

  it('WPN-12: 外した武器の出力にファイル名と pattern の誤りが入る', () => {
    const logs: string[] = [];
    reportRejectedWeapons([{ file: 'short.json', errors: [{ path: 'pattern', message: '要素数（1）が magSize（2）より少ない' }] }], (m) =>
      logs.push(m),
    );
    expect(logs).toEqual(['武器のデータ short.json を読み込めないので一覧から外す: pattern: 要素数（1）が magSize（2）より少ない']);
  });
});
