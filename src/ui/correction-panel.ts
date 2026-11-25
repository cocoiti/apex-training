import type { CorrectionPanelUse } from '../modes/types';
import type { Angles } from '../sim/angles';
import { SHOT_SECTION_SIZE } from '../sim/scoring';
import { idealCorrection, type WeaponData } from '../sim/weapon';
import { plotExtent } from './result-plot';

/**
 * 練習中のプレイ画面の補正のパネル（docs/spec/screens.md「補正のパネル」）。開始時の照準を原点とした度の座標で、
 * 理想の補正軌道の線・次の発の点・今の照準と向かう先の線・自分の照準の線を描く。表示だけで、シミュレーションと入力の記録には触れない。
 */

/** そのモードの練習でパネルを出すか。反復練習は設定によらず出し、センター維持は設定が ON のとき出す（docs/spec/modes.md「共通」）。 */
export function correctionPanelShown(use: CorrectionPanelUse | undefined, setting: boolean): boolean {
  return use === 'always' || (use === 'setting' && setting);
}

const ORIGIN: Angles = { yaw: 0, pitch: 0 };

/** 練習のあいだ変えない、武器から決まる部分。 */
export interface CorrectionPanelFrame {
  /** 原点と 1 発目〜装弾数発目の理想の補正軌道。発の順。 */
  readonly ideal: readonly Angles[];
  /** 表示の範囲の半分の幅（度）。原点を中心に縦横とも同じ。 */
  readonly extent: number;
}

/** 武器から理想の線と表示の範囲を決める。範囲は理想の線がすべて収まる幅に余白を足したもの（result-plot と同じ求め方）。 */
export function correctionPanelFrame(weapon: Pick<WeaponData, 'pattern' | 'magSize'>): CorrectionPanelFrame {
  const ideal = [ORIGIN, ...idealCorrection(weapon).slice(0, weapon.magSize)];
  return { ideal, extent: plotExtent({ series: [{ name: 'ideal', label: '', kind: 'line', points: ideal }] }) };
}

/**
 * 理想の線のうち、苦手な区間の発を結ぶ部分の点。前の発の点（1 発目からの区間では原点）から、その発の区間の最後の発
 * （装弾数を超えるときは装弾数）までの点。苦手な区間がない、または 2 点に満たないときは空。
 */
export function weakIdealPoints(frame: Pick<CorrectionPanelFrame, 'ideal'>, weakStart: number | undefined): Angles[] {
  if (weakStart === undefined) return [];
  // frame.ideal の i 番目は i 発目の点（0 番目は原点）。
  const points = frame.ideal.slice(weakStart - 1, weakStart + SHOT_SECTION_SIZE);
  return points.length >= 2 ? points : [];
}

/** 描画のたびに変わる部分。 */
export interface CorrectionPanelState {
  /** 今の発の点（次に撃つ弾の理想の補正軌道）。次に撃つ弾がない（撃ち切った）ときは undefined。 */
  readonly current: Angles | undefined;
  /** 今の発の点が何発目の点か（1 始まり）。点がないときは undefined。 */
  readonly currentShot: number | undefined;
  /** 自分の線。撃った各弾の発射時の照準（開始時の照準からの差）。撃った順。 */
  readonly own: readonly Angles[];
  /** 今の照準（開始時の照準からの差）。 */
  readonly aim: Angles;
}

export interface CorrectionPanelInput {
  /** 次の発が pattern の何発目（1 始まり）か。ゴーストと同じく Gun の nextPatternShot。 */
  readonly nextShot: number;
  readonly ammo: number;
  /** 撃った各弾の発射時の照準（PracticeSession.shotAims）。 */
  readonly shotAims: readonly Angles[];
  /** 描画の時点の利用者の照準（開始時の照準からの差。PracticeSession.aim）。 */
  readonly aim: Angles;
}

/** 今の射撃の状態からパネルの点と線を決める。今の発の点は理想の線の nextShot 発目の点。 */
export function correctionPanelState(frame: CorrectionPanelFrame, input: CorrectionPanelInput): CorrectionPanelState {
  const current = input.ammo > 0 && input.nextShot >= 1 ? frame.ideal[input.nextShot] : undefined;
  return { current, currentShot: current ? input.nextShot : undefined, own: input.shotAims, aim: input.aim };
}

/** 範囲の外の点を枠の縁に寄せる。 */
export function clampToPanel(point: Angles, extent: number): Angles {
  const clamp = (v: number) => Math.min(extent, Math.max(-extent, v));
  return { yaw: clamp(point.yaw), pitch: clamp(point.pitch) };
}

/** SVG の座標の数。小数第 4 位までにし、-0 は 0 にする。 */
function num(value: number): string {
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded === 0 ? 0 : rounded);
}

/** SVG の座標（右が +x、y は下が正なので反転する）。 */
function svgPoint(point: Angles, extent: number): { x: string; y: string } {
  const p = clampToPanel(point, extent);
  return { x: num(p.yaw), y: num(-p.pitch) };
}

function polylinePoints(points: readonly Angles[], extent: number): string {
  return points
    .map((p) => {
      const { x, y } = svgPoint(p, extent);
      return `${x},${y}`;
    })
    .join(' ');
}

/** 属性を書ける要素。 */
export interface PanelNode {
  setAttribute(name: string, value: string): void;
}

/** パネルの要素。index.html の .correction-panel の中の SVG。 */
export interface CorrectionPanelElements {
  readonly root: Pick<HTMLElement, 'hidden'>;
  readonly svg: PanelNode;
  /** 原点を通る横と縦の軸。 */
  readonly axisX: PanelNode;
  readonly axisY: PanelNode;
  readonly ideal: PanelNode;
  /** 理想の線のうち苦手な区間の部分。理想の線の上に違う色で重ねる。 */
  readonly idealWeak: PanelNode;
  /** 「苦手な区間」の凡例。苦手な区間がないときは隠す。 */
  readonly weakLegend: Pick<HTMLElement, 'hidden'>;
  readonly own: PanelNode;
  /** 自分の各弾の点を入れる g。 */
  readonly ownDots: PanelNode & Pick<Element, 'innerHTML'>;
  readonly current: PanelNode;
  /** 今の照準の印（十字の path）。 */
  readonly aim: PanelNode;
  /** 今の照準から次の発の点へ向かう先の線。 */
  readonly heading: PanelNode;
}

/**
 * パネルの表示。begin で練習の武器の理想の線と範囲を置き、update で描画のたびに今の状態を置き直し、hide で隠す。
 * 同じ値の属性は書き直さない（描画のたびに DOM を触らないように）。
 */
export class CorrectionPanel {
  private readonly elements: CorrectionPanelElements;
  private frame: CorrectionPanelFrame | undefined;
  /** 要素ごとに最後に書いた属性。 */
  private readonly written = new Map<PanelNode, Map<string, string>>();
  private dotsHtml = '';

  constructor(elements: CorrectionPanelElements) {
    this.elements = elements;
  }

  /**
   * 新しい練習を始める。理想の線と範囲を置き、自分の線を消し、今の発の点を 1 発目に戻す。表示は変えない（update で出す）。
   * weakStart は練習の組の苦手な区間の最初の発の番号。あれば理想の線のその部分を違う色で重ね、凡例を出す。練習のあいだは変えない。
   */
  begin(weapon: Pick<WeaponData, 'pattern' | 'magSize'>, weakStart?: number): void {
    const frame = correctionPanelFrame(weapon);
    this.frame = frame;
    const e = num(frame.extent);
    const w = num(2 * frame.extent);
    this.set(this.elements.svg, 'viewBox', `-${e} -${e} ${w} ${w}`);
    this.set(this.elements.axisX, 'x1', `-${e}`);
    this.set(this.elements.axisX, 'x2', e);
    this.set(this.elements.axisY, 'y1', `-${e}`);
    this.set(this.elements.axisY, 'y2', e);
    this.set(this.elements.ideal, 'points', polylinePoints(frame.ideal, frame.extent));
    this.set(this.elements.ideal, 'data-count', String(frame.ideal.length));
    const weak = weakIdealPoints(frame, weakStart);
    this.set(this.elements.idealWeak, 'points', polylinePoints(weak, frame.extent));
    this.set(this.elements.idealWeak, 'data-start', weak.length > 0 ? String(weakStart) : '');
    this.set(this.elements.idealWeak, 'visibility', weak.length > 0 ? 'inherit' : 'hidden');
    this.elements.weakLegend.hidden = weak.length === 0;
    this.render(frame, { current: frame.ideal[1], currentShot: frame.ideal[1] ? 1 : undefined, own: [], aim: ORIGIN });
  }

  /** 今の射撃の状態で置き直して表示する。begin の前は何もしない。 */
  update(input: CorrectionPanelInput): void {
    const frame = this.frame;
    if (!frame) return;
    this.render(frame, correctionPanelState(frame, input));
    if (this.elements.root.hidden) this.elements.root.hidden = false;
  }

  hide(): void {
    if (!this.elements.root.hidden) this.elements.root.hidden = true;
  }

  private render(frame: CorrectionPanelFrame, state: CorrectionPanelState): void {
    const { extent } = frame;
    const dot = extent * 0.025;
    this.set(this.elements.own, 'points', polylinePoints(state.own, extent));
    this.set(this.elements.own, 'data-count', String(state.own.length));
    // 自分の点は開始時の照準からの差の度（枠に寄せる前の値）を data-yaw・data-pitch に書く。
    const html = state.own
      .map((p) => {
        const { x, y } = svgPoint(p, extent);
        return `<circle cx="${x}" cy="${y}" r="${num(dot)}" data-yaw="${num(p.yaw)}" data-pitch="${num(p.pitch)}" />`;
      })
      .join('');
    if (html !== this.dotsHtml) {
      this.elements.ownDots.innerHTML = html;
      this.dotsHtml = html;
    }
    this.set(this.elements.ownDots, 'data-count', String(state.own.length));
    const current = state.current;
    if (current) {
      const { x, y } = svgPoint(current, extent);
      this.set(this.elements.current, 'cx', x);
      this.set(this.elements.current, 'cy', y);
      // パネルの中でいちばん目立つように、自分の点の 3 倍の大きさで塗る。
      this.set(this.elements.current, 'r', num(dot * 3));
      this.set(this.elements.current, 'data-yaw', num(current.yaw));
      this.set(this.elements.current, 'data-pitch', num(current.pitch));
      this.set(this.elements.current, 'data-shot', String(state.currentShot ?? ''));
      // visible にすると、親を隠したとき（#ui の visibility: hidden）にもこの点だけが見えてしまう。
      this.set(this.elements.current, 'visibility', 'inherit');
    } else {
      this.set(this.elements.current, 'visibility', 'hidden');
    }
    const aim = svgPoint(state.aim, extent);
    const arm = num(dot * 2.5);
    this.set(this.elements.aim, 'd', `M${aim.x} ${aim.y}m-${arm} 0h${num(dot * 5)}M${aim.x} ${aim.y}m0 -${arm}v${num(dot * 5)}`);
    this.set(this.elements.aim, 'data-yaw', num(state.aim.yaw));
    this.set(this.elements.aim, 'data-pitch', num(state.aim.pitch));
    if (current) {
      const to = svgPoint(current, extent);
      this.set(this.elements.heading, 'x1', aim.x);
      this.set(this.elements.heading, 'y1', aim.y);
      this.set(this.elements.heading, 'x2', to.x);
      this.set(this.elements.heading, 'y2', to.y);
      this.set(this.elements.heading, 'visibility', 'inherit');
    } else {
      this.set(this.elements.heading, 'visibility', 'hidden');
    }
  }

  private set(node: PanelNode, name: string, value: string): void {
    let attrs = this.written.get(node);
    if (!attrs) {
      attrs = new Map();
      this.written.set(node, attrs);
    }
    if (attrs.get(name) === value) return;
    node.setAttribute(name, value);
    attrs.set(name, value);
  }
}
