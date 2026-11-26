// docs/spec/weapons.md の受け入れ条件 WPN-30（計測した武器データの撮影の条件が確認済みとして書かれていること）の QA の受け入れテスト（#65）。
// 公開された入口だけを使う: 武器の JSON（src/data/weapons/）と、その source が指す計測の記録（docs/measurements/<id>.json）。
// 期待値は SPEC の文から求める（撮影の条件は FOV 104・壁まで 10 m・射撃中の照準の操作なしで、撮影者に確かめた条件）。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

/** 計測した武器データ（weapons.md）。 */
const MEASURED = [
  { id: 'lstar', name: 'L-STAR' },
  { id: 'car', name: 'C.A.R. SMG' },
];

const readJson = (file: string) => JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Record<string, unknown>;

/** 値の中のすべての文字列（キーの名前は含めない）。 */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** 値の中のすべてのキーの名前（入れ子も含む）。 */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]);
  return [];
}

/** 撮影の条件のそれぞれについて、文に書かれているか（表記の揺れ: 「照準の操作」「照準操作」、「10 m」「10m」）。 */
const CONDITIONS: { label: string; pattern: RegExp }[] = [
  { label: 'FOV 104', pattern: /FOV\s*104/ },
  { label: '壁まで 10 m', pattern: /壁まで\s*10\s*m/ },
  { label: '射撃中の照準の操作なし', pattern: /射撃中の?照準の?操作なし/ },
];

/** 未確認の前提・仮定であることを示す言葉。 */
const UNCONFIRMED = /仮定|未確認|前提|確かめられなかった|確認できなかった|確認していない|推定/;

describe('QA: WPN-30 計測した武器データの撮影の条件は確認済みとして書かれ、仮定の一覧はない', () => {
  describe.each(MEASURED)('$name', ({ id, name }) => {
    const weapon = readJson(`src/data/weapons/${id}.json`);
    const recordFile = `docs/measurements/${id}.json`;

    it('武器データは計測した武器データで、source が計測の記録を指している', () => {
      expect(weapon.name).toBe(name);
      expect(weapon.measured).toBe(true);
      expect(String(weapon.source)).toContain(recordFile);
    });

    it('武器データの source に、FOV 104・壁まで 10 m・射撃中の照準の操作なしが書かれ、確認済みの条件と書かれている', () => {
      const source = String(weapon.source);
      for (const c of CONDITIONS) expect(source, `source に「${c.label}」がない: ${source}`).toMatch(c.pattern);
      expect(source, `source に確認済みである旨がない: ${source}`).toMatch(/確認済み|確かめた/);
    });

    it('武器データの source に、撮影の条件が未確認の前提や仮定であるとは書かれていない', () => {
      const source = String(weapon.source);
      expect(source).not.toMatch(UNCONFIRMED);
    });

    it('計測の記録に、FOV 104・壁まで 10 m・射撃中の照準の操作なしの撮影の条件が書かれ、確認済みの条件と書かれている', () => {
      const record = readJson(recordFile);
      expect(record.weapon).toBe(id);
      const conditions = record.conditions as Record<string, unknown> | undefined;
      expect(conditions, '計測の記録に撮影の条件（conditions）がない').toBeTypeOf('object');
      const text = strings(conditions).join('\n');
      // 数値の項目で書かれていても、文で書かれていてもよい。
      const numbers = Object.values(conditions!).filter((v) => typeof v === 'number');
      expect(text.match(/FOV\s*104/) || numbers.includes(104), `撮影の条件に FOV 104 がない: ${JSON.stringify(conditions)}`).toBeTruthy();
      expect(text.match(/10\s*m/) || numbers.includes(10), `撮影の条件に壁まで 10 m がない: ${JSON.stringify(conditions)}`).toBeTruthy();
      expect(text, `撮影の条件に射撃中の照準の操作なしがない: ${JSON.stringify(conditions)}`).toMatch(
        /射撃中の?照準の?操作なし|射撃中.*(触れない|操作しない|動かさない)|^なし（射撃中/m,
      );
      // FOV・壁までの距離・射撃中の操作の 3 つが、撮影者に確かめた条件として書かれている。
      const confirmed = strings(conditions).filter((s) => /確認済み|確かめた|確認した/.test(s));
      expect(confirmed.length, `撮影の条件に確認済みである旨がない: ${JSON.stringify(conditions)}`).toBeGreaterThan(0);
      const statement = confirmed.join('\n');
      for (const c of CONDITIONS) expect(statement, `確認済みの条件に「${c.label}」が含まれない: ${statement}`).toMatch(c.pattern);
    });

    it('計測の記録に、仮定の一覧（assumptions）がない', () => {
      const record = readJson(recordFile);
      expect(keys(record).filter((k) => /assumption/i.test(k))).toEqual([]);
    });

    it('計測の記録で、撮影の条件（FOV・壁までの距離・射撃中の照準の操作）が未確認の前提や仮定とは書かれていない', () => {
      const record = readJson(recordFile);
      // 撮影の条件の欄に、未確認・仮定の言葉がない。
      const conditionTexts = strings(record.conditions);
      expect(conditionTexts.filter((s) => UNCONFIRMED.test(s))).toEqual([]);
      // 記録のどこにも「仮定」と書かれていない（SPEC: 仮定として置いた撮影の条件はない）。
      const all = strings(record);
      expect(all.filter((s) => /仮定/.test(s))).toEqual([]);
      // 未確認・前提の言葉が使われている文があれば、撮影の条件（FOV・壁までの距離・射撃中の操作）を未確認とするものではない。
      for (const s of all.filter((t) => UNCONFIRMED.test(t))) {
        for (const sentence of s.split(/。/).filter((t) => UNCONFIRMED.test(t))) {
          expect(sentence, `撮影の条件を未確認としている: ${sentence}`).not.toMatch(/壁まで|距離|射撃中.*操作|FOV\s*104.*(未確認|前提)/);
        }
      }
    });
  });
});
