import type { CorrectionPanelUse } from '../modes/types';
import type { Angles } from '../sim/angles';
import { SHOT_SECTION_SIZE } from '../sim/scoring';
import { simplePattern, type SimpleSegment } from '../sim/simple-pattern';
import { idealCorrection, type WeaponData } from '../sim/weapon';
import { plotExtent } from './result-plot';
import type { PatternDisplay } from './settings';

/**
 * 練習中のプレイ画面の補正のパネル（docs/spec/screens.md「補正のパネル」）。開始時の照準を原点とした度の座標で、
 * 理想の補正軌道の線・次の発の点・今の照準と向かう先の線・自分の照準の線を描く。表示だけで、シミュレーションと入力の記録には触れない。
 * パターンの表示が簡易のときは、理想の線と次の発の点を簡易版のパターン（src/sim/simple-pattern.ts）で描き、区切りの言葉を並べる。
 */

/** そのモードの練習でパネルを出すか。反復練習は設定によらず出し、センター維持は設定が ON のとき出す（docs/spec/modes.md「共通」）。 */
export function correctionPanelShown(use: CorrectionPanelUse | undefined, setting: boolean): boolean {
  return use === 'always' || (use === 'setting' && setting);
}

const ORIGIN: Angles = { yaw: 0, pitch: 0 };

/** 練習のあいだ変えない、武器から決まる部分。 */
export interface CorrectionPanelFrame {
  readonly display: PatternDisplay;
  /** 原点と 1 発目〜装弾数発目の理想の補正軌道（詳細版のパターン）。発の順。 */
  readonly ideal: readonly Angles[];
  /** 理想の線として描く点。詳細なら ideal、簡易なら簡易版の頂点。 */
  readonly line: readonly Angles[];
  /** i 番目は i 発目の次の発の点の位置（0 は原点）。詳細なら ideal、簡易なら簡易版での各発の位置。 */
  readonly targets: readonly Angles[];
  /** 区切り（発の順）。詳細のときは空。 */
  readonly segments: readonly SimpleSegment[];
  /** 表示の範囲の半分の幅（度）。原点を中心に縦横とも同じ。詳細版から決め、簡易でも同じ。 */
  readonly extent: number;
}

/**
 * 武器とパターンの表示から理想の線と表示の範囲を決める。範囲は詳細版の理想の線がすべて収まる幅に余白を足したもの
 * （result-plot と同じ求め方）で、パターンの表示によらない（docs/spec/screens.md UI-67）。
 */
export function correctionPanelFrame(weapon: Pick<WeaponData, 'pattern' | 'magSize'>, display: PatternDisplay = 'detailed'): CorrectionPanelFrame {
  const ideal = [ORIGIN, ...idealCorrection(weapon).slice(0, weapon.magSize)];
  const extent = plotExtent({ series: [{ name: 'ideal', label: '', kind: 'line', points: ideal }] });
  if (display === 'detailed') return { display, ideal, line: ideal, targets: ideal, segments: [], extent };
  const simple = simplePattern(weapon);
  return { display, ideal, line: simple.points, targets: simple.positions, segments: simple.segments, extent };
}

/** shot 発目（1 始まり）を受け持つ区切りの番号（0 始まり）。受け持つ区切りがないときは undefined。 */
export function segmentOfShot(segments: readonly SimpleSegment[], shot: number | undefined): number | undefined {
  if (shot === undefined) return undefined;
  const index = segments.findIndex((s) => s.from < shot && shot <= s.to);
  return index < 0 ? undefined : index;
}

/**
 * 理想の線のうち、苦手な区間の発を結ぶ部分の点。前の発の点（1 発目からの区間では原点）から、その発の区間の最後の発
 * （装弾数を超えるときは装弾数）までの点。簡易のときは簡易版での各発の位置。苦手な区間がない、または 2 点に満たないときは空。
 */
export function weakIdealPoints(frame: Pick<CorrectionPanelFrame, 'targets'>, weakStart: number | undefined): Angles[] {
  if (weakStart === undefined) return [];
  // frame.targets の i 番目は i 発目の点（0 番目は原点）。簡易なら簡易版での位置になり、簡易版の折れ線の上に乗る。
  const points = frame.targets.slice(weakStart - 1, weakStart + SHOT_SECTION_SIZE);
  return points.length >= 2 ? points : [];
}

/** 描画のたびに変わる部分。 */
export interface CorrectionPanelState {
  /** 今の発の点（次に撃つ弾の理想の補正軌道）。次に撃つ弾がない（撃ち切った）ときは undefined。 */
  readonly current: Angles | undefined;
  /** 今の発の点が何発目の点か（1 始まり）。点がないときは undefined。 */
  readonly currentShot: number | undefined;
  /** 強調する区切りの言葉（今の発を受け持つ区切りの番号、0 始まり）。詳細のときと撃ち切ったときは undefined。 */
  readonly currentSegment: number | undefined;
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

/** 今の射撃の状態からパネルの点と線を決める。今の発の点は nextShot 発目の点（簡易なら簡易版での位置）。 */
export function correctionPanelState(frame: CorrectionPanelFrame, input: CorrectionPanelInput): CorrectionPanelState {
  const current = input.ammo > 0 && input.nextShot >= 1 ? frame.targets[input.nextShot] : undefined;
  const currentShot = current ? input.nextShot : undefined;
  return { current, currentShot, currentSegment: segmentOfShot(frame.segments, currentShot), own: input.shotAims, aim: input.aim };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 区切りの言葉の一覧の中身。強調する言葉には class="current" と aria-current を付ける。 */
export function segmentListHtml(segments: readonly SimpleSegment[], current: number | undefined): string {
  return segments
    .map((s, i) => {
      const mark = i === current ? ' class="current" aria-current="step"' : '';
      return `<li data-from="${s.from + 1}" data-to="${s.to}"${mark}>${escapeHtml(s.label)}</li>`;
    })
    .join('');
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
  /** 理想の線の凡例。詳細は「理想」、簡易は「理想（簡易）」。 */
  readonly idealLegend: Pick<HTMLElement, 'textContent'>;
  /** 区切りの言葉の一覧（ol）。簡易のときだけ出す。 */
  readonly segments: PanelNode & Pick<HTMLElement, 'hidden' | 'innerHTML'>;
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
  private segmentsHtml = '';

  constructor(elements: CorrectionPanelElements) {
    this.elements = elements;
  }

  /**
   * 新しい練習を始める。パターンの表示に合わせて理想の線と区切りの言葉を置き、範囲を置き、自分の線を消し、
   * 今の発の点を 1 発目に戻す。表示は変えない（update で出す）。
   * weakStart は練習の組の苦手な区間の最初の発の番号。あれば理想の線のその部分を違う色で重ね、凡例を出す。練習のあいだは変えない。
   */
  begin(weapon: Pick<WeaponData, 'pattern' | 'magSize'>, options: { readonly weakStart?: number | undefined; readonly display?: PatternDisplay } = {}): void {
    const { weakStart, display = 'detailed' } = options;
    const frame = correctionPanelFrame(weapon, display);
    this.frame = frame;
    const e = num(frame.extent);
    const w = num(2 * frame.extent);
    this.set(this.elements.svg, 'viewBox', `-${e} -${e} ${w} ${w}`);
    this.set(this.elements.axisX, 'x1', `-${e}`);
    this.set(this.elements.axisX, 'x2', e);
    this.set(this.elements.axisY, 'y1', `-${e}`);
    this.set(this.elements.axisY, 'y2', e);
    this.set(this.elements.ideal, 'points', polylinePoints(frame.line, frame.extent));
    this.set(this.elements.ideal, 'data-count', String(frame.line.length));
    this.set(this.elements.ideal, 'data-display', display);
    const weak = weakIdealPoints(frame, weakStart);
    this.set(this.elements.idealWeak, 'points', polylinePoints(weak, frame.extent));
    this.set(this.elements.idealWeak, 'data-start', weak.length > 0 ? String(weakStart) : '');
    this.set(this.elements.idealWeak, 'visibility', weak.length > 0 ? 'inherit' : 'hidden');
    this.elements.weakLegend.hidden = weak.length === 0;
    const legend = display === 'simple' ? '理想（簡易）' : '理想';
    if (this.elements.idealLegend.textContent !== legend) this.elements.idealLegend.textContent = legend;
    const simple = display === 'simple';
    if (this.elements.segments.hidden === simple) this.elements.segments.hidden = !simple;
    this.set(this.elements.segments, 'data-count', String(frame.segments.length));
    const first = frame.targets[1] ? 1 : undefined;
    this.render(frame, {
      current: frame.targets[1],
      currentShot: first,
      currentSegment: segmentOfShot(frame.segments, first),
      own: [],
      aim: ORIGIN,
    });
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
    const segmentsHtml = segmentListHtml(frame.segments, state.currentSegment);
    if (segmentsHtml !== this.segmentsHtml) {
      this.elements.segments.innerHTML = segmentsHtml;
      this.segmentsHtml = segmentsHtml;
    }
    this.set(this.elements.segments, 'data-current', state.currentSegment === undefined ? '' : String(state.currentSegment));
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
