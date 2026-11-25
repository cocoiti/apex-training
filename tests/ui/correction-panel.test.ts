import { describe, expect, it } from 'vitest';
import { idealCorrection, type RecoilStep, type WeaponData } from '../../src/sim/weapon';
import { plotExtent } from '../../src/ui/result-plot';
import {
  clampToPanel,
  CorrectionPanel,
  correctionPanelFrame,
  correctionPanelShown,
  correctionPanelState,
  weakIdealPoints,
  type CorrectionPanelElements,
} from '../../src/ui/correction-panel';

function makeWeapon(magSize = 6): WeaponData {
  const pattern: RecoilStep[] = Array.from({ length: magSize }, (_, i) => ({ dx: ((i % 3) - 1) * 0.2, dy: 0.5 + i * 0.1 }));
  return { id: 'w', name: 'テスト武器', category: 'AR', version: 'v', source: '仮データ', measured: false, rpm: 600, magSize, pattern, randomness: 0 };
}

/** 書いた属性と innerHTML と setAttribute の回数を持つ要素。 */
function fakeNode() {
  const attrs = new Map<string, string>();
  const node = {
    attrs,
    writes: 0,
    innerHTML: '',
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
      node.writes += 1;
    },
  };
  return node;
}

function elements() {
  return {
    root: { hidden: true },
    svg: fakeNode(),
    axisX: fakeNode(),
    axisY: fakeNode(),
    ideal: fakeNode(),
    idealWeak: fakeNode(),
    weakLegend: { hidden: true },
    own: fakeNode(),
    ownDots: fakeNode(),
    current: fakeNode(),
    aim: fakeNode(),
    heading: fakeNode(),
  } satisfies CorrectionPanelElements;
}

const O = { yaw: 0, pitch: 0 };

/** polyline の points を度の座標（上が正）に戻す。 */
function parsePoints(points: string | undefined): { yaw: number; pitch: number }[] {
  if (!points) return [];
  return points.split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return { yaw: x ?? Number.NaN, pitch: 0 - (y ?? Number.NaN) };
  });
}

describe('補正のパネルを出すモード', () => {
  it('反復練習（always）は設定によらず出し、センター維持（setting）は設定が ON のときだけ出し、持たないモードは出さない', () => {
    expect(correctionPanelShown('always', false)).toBe(true);
    expect(correctionPanelShown('always', true)).toBe(true);
    expect(correctionPanelShown('setting', true)).toBe(true);
    expect(correctionPanelShown('setting', false)).toBe(false);
    expect(correctionPanelShown(undefined, true)).toBe(false);
  });
});

describe('補正のパネルの範囲と理想の線', () => {
  it('理想の線は原点と 1 発目〜装弾数発目の理想の補正軌道で、範囲はそれがすべて収まる幅に余白を足したもの', () => {
    const weapon = makeWeapon();
    const frame = correctionPanelFrame(weapon);
    expect(frame.ideal).toEqual([{ yaw: 0, pitch: 0 }, ...idealCorrection(weapon)]);
    const farthest = Math.max(...frame.ideal.map((p) => Math.max(Math.abs(p.yaw), Math.abs(p.pitch))));
    expect(frame.extent).toBeGreaterThan(farthest);
    expect(frame.extent).toBe(plotExtent({ series: [{ name: 'ideal', label: '', kind: 'line', points: frame.ideal }] }));
  });

  it('範囲の外の点は枠の縁に寄せる', () => {
    expect(clampToPanel({ yaw: 5, pitch: -9 }, 3)).toEqual({ yaw: 3, pitch: -3 });
    expect(clampToPanel({ yaw: -1, pitch: 2 }, 3)).toEqual({ yaw: -1, pitch: 2 });
  });
});

describe('補正のパネルの今の発の点と自分の線', () => {
  const weapon = makeWeapon();
  const frame = correctionPanelFrame(weapon);
  const ideal = idealCorrection(weapon);

  it('UI-55: 撃つ前は 1 発目の位置、i 発目を撃つと i+1 発目の位置に進み、撃ち切ると点はない', () => {
    expect(correctionPanelState(frame, { nextShot: 1, ammo: 6, shotAims: [], aim: O })).toEqual({ current: ideal[0], currentShot: 1, own: [], aim: O });
    expect(correctionPanelState(frame, { nextShot: 3, ammo: 4, shotAims: [], aim: O }).current).toEqual(ideal[2]);
    expect(correctionPanelState(frame, { nextShot: 7, ammo: 0, shotAims: [], aim: O }).current).toBeUndefined();
  });

  it('UI-56: 照準を動かさずに 5 発撃つと、自分の点はすべて原点で、k 発目の理想の点との距離は原点からの距離', () => {
    const aims = Array.from({ length: 5 }, () => ({ yaw: 0, pitch: 0 }));
    const state = correctionPanelState(frame, { nextShot: 6, ammo: 1, shotAims: aims, aim: O });
    expect(state.own).toEqual(aims);
    state.own.forEach((p, i) => {
      const target = ideal[i] ?? { yaw: 0, pitch: 0 };
      expect(Math.hypot(p.yaw - target.yaw, p.pitch - target.pitch)).toBeCloseTo(Math.hypot(target.yaw, target.pitch), 12);
    });
  });
});

describe('補正のパネルの苦手な区間', () => {
  it('前の発の点からその発の区間の最後の発までの理想の線の点を取り、1 発目からの区間は原点から始める', () => {
    const frame = correctionPanelFrame(makeWeapon(20));
    expect(weakIdealPoints(frame, 11)).toEqual(frame.ideal.slice(10, 16));
    expect(weakIdealPoints(frame, 1)).toEqual(frame.ideal.slice(0, 6));
    expect(weakIdealPoints(frame, undefined)).toEqual([]);
    // 装弾数を超えるところは装弾数まで。発の区間の点がなければ空。
    expect(weakIdealPoints(frame, 16)).toEqual(frame.ideal.slice(15, 21));
    expect(weakIdealPoints(frame, 21)).toEqual([]);
  });

  it('UI-67: 11〜15 発目が苦手な区間なら、理想の線のその部分を重ねて描き、「苦手な区間」の凡例を出す', () => {
    const weapon = makeWeapon(20);
    const e = elements();
    new CorrectionPanel(e).begin(weapon, 11);
    const weak = parsePoints(e.idealWeak.attrs.get('points'));
    const line = parsePoints(e.ideal.attrs.get('points'));
    expect(weak).toEqual(line.slice(10, 16));
    expect(e.idealWeak.attrs.get('visibility')).toBe('inherit');
    expect(e.idealWeak.attrs.get('data-start')).toBe('11');
    expect(e.weakLegend.hidden).toBe(false);
  });

  it('UI-68: 苦手な区間が「なし」なら重ねる線を描かず、凡例を隠す。次の練習で「なし」になれば消す', () => {
    const weapon = makeWeapon(20);
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon, 6);
    panel.begin(weapon);
    expect(e.idealWeak.attrs.get('points')).toBe('');
    expect(e.idealWeak.attrs.get('visibility')).toBe('hidden');
    expect(e.weakLegend.hidden).toBe(true);
  });
});

describe('補正のパネルの要素', () => {
  const weapon = makeWeapon();
  const ideal = idealCorrection(weapon);

  it('UI-55: 始めると理想の線と 1 発目の今の発の点を置き、表示は update で出す', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    expect(e.root.hidden).toBe(true);
    expect(e.ideal.attrs.get('data-count')).toBe(String(weapon.magSize + 1));
    const line = parsePoints(e.ideal.attrs.get('points'));
    expect(line[0]).toEqual({ yaw: 0, pitch: 0 });
    line.slice(1).forEach((p, i) => {
      expect(p.yaw).toBeCloseTo(ideal[i]?.yaw ?? Number.NaN, 4);
      expect(p.pitch).toBeCloseTo(ideal[i]?.pitch ?? Number.NaN, 4);
    });
    expect(e.current.attrs.get('data-shot')).toBe('1');
    expect(Number(e.current.attrs.get('data-pitch'))).toBeCloseTo(ideal[0]?.pitch ?? Number.NaN, 4);
    expect(e.svg.attrs.get('viewBox')).toMatch(/^-\S+ -\S+ \S+ \S+$/);

    panel.update({ nextShot: 2, ammo: 5, shotAims: [{ yaw: 0, pitch: 0 }], aim: O });
    expect(e.root.hidden).toBe(false);
    expect(e.current.attrs.get('data-shot')).toBe('2');
    expect(Number(e.current.attrs.get('data-pitch'))).toBeCloseTo(ideal[1]?.pitch ?? Number.NaN, 4);
    expect(e.own.attrs.get('data-count')).toBe('1');
    expect(e.ownDots.innerHTML).toContain('data-yaw="0" data-pitch="0"');

    panel.hide();
    expect(e.root.hidden).toBe(true);
  });

  it('UI-57: 照準を理想の補正軌道に合わせて撃つと、自分の点が理想の線の各発の点に重なる', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    panel.update({ nextShot: 7, ammo: 0, shotAims: ideal, aim: O });
    const own = parsePoints(e.own.attrs.get('points'));
    const line = parsePoints(e.ideal.attrs.get('points')).slice(1);
    expect(own).toEqual(line);
    expect(e.current.attrs.get('visibility')).toBe('hidden');
  });

  it('UI-60: やり直しで始め直すと、自分の線が消えて今の発の点が 1 発目に戻る', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    panel.update({ nextShot: 4, ammo: 3, shotAims: ideal.slice(0, 3), aim: O });
    panel.hide();
    panel.begin(weapon);
    expect(e.root.hidden).toBe(true);
    expect(e.own.attrs.get('data-count')).toBe('0');
    expect(e.own.attrs.get('points')).toBe('');
    expect(e.ownDots.innerHTML).toBe('');
    expect(e.current.attrs.get('data-shot')).toBe('1');
    expect(e.current.attrs.get('visibility')).toBe('inherit');
  });

  it('範囲の外の自分の点は枠の縁に寄せて描き、data-yaw・data-pitch には寄せる前の度を書く', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    const extent = correctionPanelFrame(weapon).extent;
    panel.update({ nextShot: 2, ammo: 5, shotAims: [{ yaw: 100, pitch: -100 }], aim: O });
    const [own] = parsePoints(e.own.attrs.get('points'));
    expect(own?.yaw).toBeCloseTo(extent, 4);
    expect(own?.pitch).toBeCloseTo(-extent, 4);
    expect(e.ownDots.innerHTML).toContain('data-yaw="100" data-pitch="-100"');
  });

  it('状態が変わらなければ描画のたびに属性を書き直さない（一時停止中は同じ表示のまま）', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    const input = { nextShot: 2, ammo: 5, shotAims: [{ yaw: 0.1, pitch: -0.2 }], aim: O };
    panel.update(input);
    const writes = e.current.writes + e.own.writes + e.ownDots.writes;
    panel.update(input);
    expect(e.current.writes + e.own.writes + e.ownDots.writes).toBe(writes);
  });

  it('UI-63: 今の照準の印を照準の位置に置き、今の照準から次の発の点へ向かう先の線を引く。撃ち切ると線は消える', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    expect(e.aim.attrs.get('data-yaw')).toBe('0');
    panel.update({ nextShot: 1, ammo: 6, shotAims: [], aim: { yaw: 2, pitch: 1 } });
    expect(e.aim.attrs.get('data-yaw')).toBe('2');
    expect(e.aim.attrs.get('data-pitch')).toBe('1');
    expect(e.heading.attrs.get('x1')).toBe('2');
    expect(e.heading.attrs.get('y1')).toBe('-1');
    expect(Number(e.heading.attrs.get('x2'))).toBeCloseTo(ideal[0]?.yaw ?? Number.NaN, 4);
    expect(Number(e.heading.attrs.get('y2'))).toBeCloseTo(-(ideal[0]?.pitch ?? Number.NaN), 4);
    expect(e.heading.attrs.get('visibility')).toBe('inherit');
    panel.update({ nextShot: 7, ammo: 0, shotAims: ideal, aim: { yaw: 2, pitch: 1 } });
    expect(e.heading.attrs.get('visibility')).toBe('hidden');
  });

  it('次の発の点は自分の点より大きく描く', () => {
    const e = elements();
    const panel = new CorrectionPanel(e);
    panel.begin(weapon);
    panel.update({ nextShot: 2, ammo: 5, shotAims: [{ yaw: 0, pitch: 0 }], aim: O });
    const own = Number(/r="([\d.]+)"/.exec(e.ownDots.innerHTML)?.[1]);
    expect(Number(e.current.attrs.get('r'))).toBeGreaterThan(own * 2);
  });

  it('begin の前の update は何もしない', () => {
    const e = elements();
    new CorrectionPanel(e).update({ nextShot: 1, ammo: 6, shotAims: [], aim: O });
    expect(e.root.hidden).toBe(true);
    expect(e.current.writes).toBe(0);
  });
});
