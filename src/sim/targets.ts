import { vec3, type Vec3 } from './vec3';

/**
 * 練習の的（docs/spec/architecture.md「練習の的」）。モードが練習ごとに置く、マップの箱とは別の的。
 * 中心の位置は練習の開始からの時刻（固定ステップの時刻、秒）で決まり、出現の時刻と消える時刻を持てる。
 * 決定の理由は docs/adr/2026-11-26-practice-targets-in-world.md。
 */

/** 浮動小数の誤差で、ちょうどステップの境目の出現・消える時刻を 1 ステップずらさないための許容幅（秒）。 */
const EPSILON = 1e-9;

/**
 * 練習の的の部分の箱（docs/spec/architecture.md「練習の的」）。軸に平行な箱の大きさと、的の中心からの相対的な位置を持つ。
 * 人形の的（src/sim/humanoid.ts）は頭・胴・腕・脚の 6 つの部分の箱でできている。
 */
export interface TargetPart {
  /** 部分の識別子（人形では head・torso など）。的の中で重ならない。 */
  readonly id: string;
  /** 幅（X）・高さ（Y）・奥行き（Z）。メートル。 */
  readonly size: Vec3;
  /** 的の中心からの相対的な位置（メートル）。 */
  readonly offset: Vec3;
}

/** 大きさ size の 1 つの箱だけの的の形（部分の箱が 1 つで、相対的な位置が 0）。 */
export function singleBoxParts(size: Vec3): TargetPart[] {
  return [{ id: 'box', size, offset: vec3(0, 0, 0) }];
}

/** 的の中心が center のときの、部分の箱の中心の位置。 */
export function partCenter(center: Vec3, part: TargetPart): Vec3 {
  return vec3(center.x + part.offset.x, center.y + part.offset.y, center.z + part.offset.z);
}

/** 練習の的の形の決め方。1 つの箱だけの的は size、部分の箱を組み合わせた的（人形）は parts で渡す。 */
export type PracticeTargetShape = { readonly size: Vec3; readonly parts?: undefined } | { readonly parts: readonly TargetPart[]; readonly size?: undefined };

/** 練習の的の決め方。モードが add に渡す。 */
export type PracticeTargetSpec = PracticeTargetShape & PracticeTargetOptions;

/** 練習の的の決め方のうち、形の外のもの。 */
export interface PracticeTargetOptions {
  /** 識別子。練習の中で重ならない。弾の記録の target に入る。 */
  readonly id: string;
  /**
   * 中心の位置（メートル）。練習の開始からの時刻（秒）から位置を返す動きの関数か、位置の変わらない的では位置そのもの。
   * 関数は同じ時刻に同じ位置を返す（乱数を使うときは、作るときに練習の種付きの乱数から決めておく）。
   */
  readonly position: Vec3 | ((time: number) => Vec3);
  /** 出現の時刻（秒）。省くと 0（始めから出現している）。 */
  readonly appearAt?: number;
  /** 消える時刻（秒）。省くと、モードが消すまで出現している。 */
  readonly disappearAt?: number;
  /** 照準が乗っているあいだ、乗っていないときと違う色で表示するか（docs/spec/screens.md「3D の表示」）。省くと同じ色。表示だけのもの。 */
  readonly highlightAimed?: boolean;
  /**
   * 弾痕を残すか（docs/spec/architecture.md「照準と的の当たり」）。残す的に当たった弾は、当たった点を弾痕の位置として記録し、
   * その的の上に弾痕を表示する。省くと残さない（弾痕を表示しない）。
   */
  readonly keepsImpacts?: boolean;
  /** 的の正面に的のリングと中心点を描くか（docs/spec/screens.md「3D の表示」）。省くと描かない。表示だけのもの。 */
  readonly rings?: boolean;
}

/** 練習の的の今の状態。シミュレーションが書き換え、描画とモードは読むだけ。 */
export interface PracticeTarget {
  readonly id: string;
  /** 形（1 つ以上の部分の箱）。描画も同じ形を読んで表示を作る。 */
  readonly parts: readonly TargetPart[];
  /** 最後のステップの終わりの時刻の中心の位置。 */
  readonly center: Vec3;
  /** 直前のステップの終わりの時刻の中心の位置。描画の補間に使う。足したばかりの的では center と同じ。 */
  readonly previousCenter: Vec3;
  /** 最後のステップで出現しているか。 */
  readonly visible: boolean;
  readonly appearAt: number;
  readonly disappearAt: number | undefined;
  /** 照準が乗っているあいだ違う色で表示するか。 */
  readonly highlightAimed: boolean;
  /** 弾痕を残すか。 */
  readonly keepsImpacts: boolean;
  /** 正面に的のリングと中心点を描くか。 */
  readonly rings: boolean;
}

interface Entry {
  readonly spec: PracticeTargetSpec;
  state: PracticeTarget;
}

function positionAt(spec: PracticeTargetSpec, time: number): Vec3 {
  return typeof spec.position === 'function' ? spec.position(time) : spec.position;
}

/**
 * ステップ [start, end) で出現しているか。出現の時刻を含むステップから、消える時刻を含むステップの前まで出現している。
 * 消える時刻がステップの終わりちょうどなら、そのステップまでは出現している。
 */
export function visibleInStep(target: { readonly appearAt: number; readonly disappearAt: number | undefined }, end: number): boolean {
  if (target.appearAt >= end - EPSILON) return false;
  return target.disappearAt === undefined || target.disappearAt >= end - EPSILON;
}

/**
 * 1 回の練習の練習の的の集まり（World が持ち、練習ごとに作り直す）。Simulation がステップごとに update を呼び、
 * そのステップの終わりの時刻で中心の位置と出現を決める。位置と出現は固定ステップの時刻だけで決まる。
 */
export class PracticeTargets {
  private readonly entries: Entry[] = [];
  /** 最後に update したステップの終わりの時刻（秒）。まだ進めていなければ 0。 */
  private time = 0;
  private aimedId: string | undefined;

  /** 今の練習の的。足した順。 */
  get all(): readonly PracticeTarget[] {
    return this.entries.map((e) => e.state);
  }

  /** 最後のステップで出現している的。照準の当たりと弾の当たりはこれだけを対象にする。 */
  get visible(): readonly PracticeTarget[] {
    return this.all.filter((t) => t.visible);
  }

  /** 最後のステップで照準が乗っている的の識別子。どれにも乗っていなければ undefined（docs/spec/architecture.md「照準と的の当たり」）。 */
  get aimed(): string | undefined {
    return this.aimedId;
  }

  /** その的に照準が乗っているか。 */
  isAimed(id: string): boolean {
    return this.aimedId === id;
  }

  /** 識別子の的。なければ undefined。 */
  get(id: string): PracticeTarget | undefined {
    return this.entries.find((e) => e.state.id === id)?.state;
  }

  /**
   * 的を足す。位置と出現は最後のステップの終わりの時刻で決め、照準と弾の当たりには次のステップから入る。
   * 同じ識別子の的があれば投げる。
   */
  add(spec: PracticeTargetSpec): void {
    if (this.entries.some((e) => e.state.id === spec.id)) throw new Error(`practice target id "${spec.id}" is a duplicate`);
    const center = positionAt(spec, this.time);
    const appearAt = spec.appearAt ?? 0;
    const disappearAt = spec.disappearAt;
    const timing = { appearAt, disappearAt };
    this.entries.push({
      spec,
      state: {
        id: spec.id,
        parts: spec.parts ? [...spec.parts] : singleBoxParts(spec.size),
        center,
        previousCenter: center,
        visible: this.time > 0 && visibleInStep(timing, this.time),
        appearAt,
        disappearAt,
        highlightAimed: spec.highlightAimed ?? false,
        keepsImpacts: spec.keepsImpacts ?? false,
        rings: spec.rings ?? false,
      },
    });
  }

  /** 的を消す。消したら true。 */
  remove(id: string): boolean {
    const index = this.entries.findIndex((e) => e.state.id === id);
    if (index < 0) return false;
    this.entries.splice(index, 1);
    if (this.aimedId === id) this.aimedId = undefined;
    return true;
  }

  /** ステップ [start, end) の位置と出現にする。end はそのステップの終わりの時刻（秒）。Simulation が入力を適用したあとに呼ぶ。 */
  update(end: number): void {
    this.time = end;
    for (const entry of this.entries) {
      const { state, spec } = entry;
      entry.state = { ...state, previousCenter: state.center, center: positionAt(spec, end), visible: visibleInStep(state, end) };
    }
  }

  /** 照準が乗っている的を決める。aimed は照準のレイが最初に当たった練習の的の識別子（壁が手前なら undefined）。 */
  setAimed(aimed: string | undefined): void {
    this.aimedId = aimed;
  }
}
