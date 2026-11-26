import type { Random } from '../core/random';
import type { Angles } from '../sim/angles';
import type { Gun, ShotRecord } from '../sim/gun';
import type { PracticeTargets } from '../sim/targets';
import type { World } from '../sim/world';
import type { Localized } from '../ui/i18n';

export type { Localized } from '../ui/i18n';

/** モードの種類（docs/spec/modes.md「モードの登録」）。`aim` は追いエイム・フリックなどのエイムの練習。 */
export type ModeCategory = 'recoil' | 'aim' | 'movement' | 'combined';

/**
 * 補正のパネル（docs/spec/screens.md「補正のパネル」）の出し方。`always` は設定によらず必ず出す。持たないモードは出さない。
 * パネルを消す設定の項目はない（決定の理由は docs/adr/2026-11-26-remove-center-mode-and-panel-setting.md）。
 */
export type CorrectionPanelUse = 'always';

/**
 * トップ画面のモードのカードのアイコンの形（docs/spec/screens.md「トップ画面」）。形の絵は src/ui/mode-icons.ts が自作の SVG で描く。
 * `spray` はリコイルの弾の並び、`track` は左右に動く的、`track-spray` は動く的と弾の並び、`flick` は離れた的へ跳ぶ照準。
 */
export type ModeIcon = 'spray' | 'track' | 'track-spray' | 'flick';

/** モードのアイコンの形の一覧。モードのファイルはこのどれかを選ぶ。 */
export const MODE_ICONS: readonly ModeIcon[] = ['spray', 'track', 'track-spray', 'flick'];

/**
 * 練習モードに渡すもの。シミュレーションの状態、その練習の武器（残弾・弾痕の記録。武器を使わないモードでは undefined）、
 * 撃った弾、練習の的、種付きの乱数、今のステップの終わりの時刻。
 */
export interface ModeContext {
  readonly world: World;
  /** その練習の武器。武器を使わないモードでは undefined。 */
  readonly gun: Gun | undefined;
  /** 撃った弾の記録。撃った順。武器を使わないモードでも、fire の押し始めごとの 1 発が入る。 */
  readonly shots: readonly ShotRecord[];
  /** 練習の的。モードが setup と step で足したり消したりする（docs/spec/architecture.md「練習の的」）。 */
  readonly targets: PracticeTargets;
  readonly random: Random;
  /** 練習の開始から今のステップの終わりまでの時間（秒、固定ステップの時刻）。setup では 0。 */
  readonly time: number;
  /** 練習の選択肢（options）で選んだ値の id（選択肢の id → 値の id）。練習の選択肢を持たないモードでは空。 */
  readonly options: ModeOptionValues;
}

/** 練習の選択肢で選んだ値（選択肢の id → 値の id）。 */
export type ModeOptionValues = Readonly<Record<string, string>>;

/** 練習の選択肢の 1 つの値（例: 速さの「ふつう」）。 */
export interface ModeOptionChoice {
  /** 保存のキーの末尾に足す id（例: `normal`）。英小文字・数字・`-` だけ。 */
  readonly id: string;
  /** 表示名（日本語と英語。例: 「ふつう」・`Normal`）。 */
  readonly name: Localized;
}

/**
 * 練習の選択肢（docs/spec/modes.md「モードの登録」。追いエイムの速さ、フリックの出る範囲など）。持つモードはトップ画面でその値を選んで
 * 練習を始め、自己ベストと履歴を値の組ごとに分ける。決定の理由は docs/adr/2026-11-26-mode-practice-options-list.md。
 */
export interface ModeOption {
  /** 選択肢の id（例: `speed`）。同じ id の選択肢を持つモードどうしは、トップ画面と履歴の画面で選んだ値を共有する。 */
  readonly id: string;
  /** 表示名（日本語と英語。例: 「速さ」・`Speed`）。 */
  readonly label: Localized;
  /** 選べる値。並び順に表示する。 */
  readonly choices: readonly ModeOptionChoice[];
  /** 開いたときに選んでいる値の id。choices のどれか。 */
  readonly defaultChoice: string;
}

/**
 * 練習モードが結果に足すもの。採点（scoring）に渡す。弾痕のズレの採点（scoring を持たないモード）は練習の結果から
 * 共通の処理が行う（src/ui/result-view.ts）ので、足すものはない。決定の理由は docs/adr/2026-11-26-all-modes-scored.md。
 */
export type ModeResult = Readonly<Record<string, unknown>>;

/** 指標の名前・単位・書き方（docs/spec/scoring.md「モードごとの採点」）。 */
export interface MetricSpec {
  /** 保存の項目名（自己ベストと履歴の 1 件の項目）。`version`・`achievedAt`・`at` は使えない。 */
  readonly id: string;
  /** 表示名（例: 「命中数」）。今の表示の言語の文言で、辞書（src/ui/messages/）から読む。 */
  readonly label: string;
  /** 図の軸に添える単位（例: `°`。ないときは空文字）。今の表示の言語のもの。 */
  readonly unit: string;
  /** 値の書き方（例: `13`、`0.85°`）。リザルト画面・履歴・セットのまとめ・シェアの文で同じ書き方にする。 */
  format(value: number): string;
}

/** 比べる指標（docs/spec/scoring.md「用語」）。自己ベストと履歴で比べる 1 つの指標と、良いとする向き。 */
export interface CompareMetric extends MetricSpec {
  /** lower は小さいほど良い、higher は大きいほど良い。 */
  readonly better: 'lower' | 'higher';
  /**
   * セットのまとめのシェアの文で「セットの」のあとに書く名前（例: 「平均の命中 1 回あたりの時間」）。省くと「平均<label>」
   * （docs/spec/screens.md「シェアの文」）。
   */
  readonly averageLabel?: string;
  /** 保存してある値がこの指標のとりうる値か。省くと有限の数ならとりうる値。 */
  valid?(value: number): boolean;
}

/** 採点に渡す、その練習の記録。同じ入力の記録と種なら同じものになる。 */
export interface ScoringInput {
  /** 撃った弾の記録。練習の的に当たった弾は target を持つ。 */
  readonly shots: readonly ShotRecord[];
  /** 練習の開始から終わりまでの時間（秒、固定ステップの時刻）。 */
  readonly duration: number;
  /** モードの result が返したもの（各ステップの照準と的の当たりから求めたものなど）。 */
  readonly modeResult: ModeResult;
}

/** リザルト画面の指標の 1 行。 */
export interface ScoreRow {
  readonly label: string;
  readonly value: string;
}

/** モードの採点の結果。 */
export interface ModeScore {
  /** 比べる指標の値。求まらないとき（自己ベストの判定にも履歴にも使わない）は null。 */
  readonly value: number | null;
  /** リザルト画面に出す指標の行。 */
  readonly metrics: readonly ScoreRow[];
  /** リザルト画面と短いリザルトに出すコメント（今の表示の言語の文言）。 */
  readonly comments?: readonly string[];
  /** 自己ベストと履歴の 1 件に、比べる指標と一緒に保存する指標（項目名 → 値）。 */
  readonly fields?: Readonly<Record<string, number>>;
  /** リザルト画面のシェアの文の 3 行目。省くと「<比べる指標の名前>: <値>」（docs/spec/screens.md「シェアの文」）。 */
  readonly share?: string;
}

/**
 * モードの採点の仕方（docs/spec/scoring.md「モードごとの採点」）。持たないモードは弾痕のズレの採点（比べる指標は平均ズレ）で採点する。
 * 決定の理由は docs/adr/2026-11-26-mode-scoring-and-weaponless-modes.md。
 */
export interface ModeScoring {
  readonly compare: CompareMetric;
  /** 履歴の画面の一覧で、比べる指標のあとに並べる指標。値は履歴の 1 件の同じ id の項目。 */
  readonly columns?: readonly MetricSpec[];
  /** 練習の記録から採点する。ブラウザの状態や時計を使わず、記録だけから決める。 */
  score(input: ScoringInput): ModeScore;
}

/**
 * 練習モードの共通の型（docs/spec/architecture.md「モードとマップの追加」）。
 * 準備 → ステップごとの処理 → 結果 → 片付けの順に呼ぶ。
 * モードのファイル（`src/modes/<category>/*.ts`）はこの型を default で export する（src/modes/registry.ts）。
 * 1 つのモードを練習ごとに使い回すので、練習ごとの状態は setup で作り直す。
 */
export interface TrainingMode<TResult extends ModeResult = ModeResult> {
  readonly id: string;
  /** 表示名（日本語と英語、docs/spec/modes.md「モードの登録」）。 */
  readonly name: Localized;
  /** トップ画面のモードのカードに出すひとこと説明（1 文、日本語と英語、docs/spec/modes.md「モードの登録」）。 */
  readonly description: Localized;
  /** トップ画面のモードのカードのアイコンの形。 */
  readonly icon: ModeIcon;
  readonly category: ModeCategory;
  /** トップ画面の選択肢の並び順。小さいほど前。同じならファイル名の順。 */
  readonly order: number;
  /**
   * 武器を使うか（docs/spec/modes.md「モードの登録」）。省くと使う。使わないモードはトップ画面の武器を使わず、
   * リコイルをかけず、fire の押し始めごとに 1 発を撃つ（docs/spec/architecture.md「武器を使わない練習」）。
   */
  readonly usesWeapon?: boolean;
  /** 制限時間（秒）。練習の開始からこの時間がたったステップで練習を終える。省くと制限時間で終わらない。 */
  readonly timeLimit?: number;
  /** 採点の仕方。省くと弾痕のズレの採点。 */
  readonly scoring?: ModeScoring;
  /** 苦手な区間を使うか。弾痕のズレの採点のモード（scoring を持たない）だけで意味を持ち、省くと使う。 */
  readonly weakSections?: boolean;
  /** 向きの音を使うか（docs/spec/screens.md「音」）。武器を使うモードだけで意味を持ち、省くと使う。 */
  readonly directionSound?: boolean;
  /** 補正のパネルの出し方。持たないモードでは出さない。武器を使わないモードでは出さない。 */
  readonly correctionPanel?: CorrectionPanelUse;
  /** 練習の選択肢。並び順にトップ画面に欄を出し、保存のキーに値の id を足す。省くと持たない（反復練習）。 */
  readonly options?: readonly ModeOption[];
  /**
   * 撃ち切ったあと fire を離すと残弾を装弾数に戻すか（docs/spec/modes.md「追いエイム」）。武器を使うモードだけで意味を持ち、省くと戻さない。
   * 戻すモードは撃ち切りと「離して 2 秒」では終わらず、モードが決めた終わりの条件（制限時間など）だけで終わる。
   */
  readonly refillOnRelease?: boolean;
  /** 練習の開始時に 1 回呼ぶ。練習の的はここで足せる。 */
  setup(context: ModeContext): void;
  /**
   * 固定ステップごとに、入力と射撃を適用し、照準と的の当たりを求めたあとに呼ぶ。練習を続けるなら true、終えるなら false を返す。
   * 撃ち切りと撃たない時間（武器を使うモード）と制限時間による終わりは、モードによらず練習の側で判定する（src/sim/practice.ts）。
   */
  step(context: ModeContext, dt: number): boolean;
  /** 練習の結果を返す。 */
  result(context: ModeContext): TResult;
  /** 練習の終わりに 1 回呼ぶ。 */
  teardown(context: ModeContext): void;
  /**
   * ゴーストを表示するモードだけが持つ。今のステップの状態からゴーストの向き（ヨー・ピッチ、度）を返し、
   * 表示しないときは undefined を返す。描画のたびに呼ぶので、シミュレーションの状態を変えない（docs/spec/modes.md「反復練習」）。
   */
  ghost?(context: ModeContext): Angles | undefined;
  /**
   * HUD に出すモードの表示（例: 「的: 3 / 20」）を返す。出さないときは undefined。持たないモードは出さない。
   * 描画のたびに呼ぶので、シミュレーションの状態を変えない。
   */
  status?(context: ModeContext): string | undefined;
}

/** モードが武器を使うか。usesWeapon を省いたモードは使う。 */
export function modeUsesWeapon(mode: Pick<TrainingMode, 'usesWeapon'>): boolean {
  return mode.usesWeapon !== false;
}

/** モードが苦手な区間を使うか。弾痕のズレの採点のモードで、weakSections が false でないとき。 */
export function modeUsesWeakSections(mode: Pick<TrainingMode, 'scoring' | 'weakSections'>): boolean {
  return mode.scoring === undefined && mode.weakSections !== false;
}

/** モードが向きの音を使うか。武器を使うモードで、directionSound が false でないとき。 */
export function modeUsesDirectionSound(mode: Pick<TrainingMode, 'usesWeapon' | 'directionSound'>): boolean {
  return modeUsesWeapon(mode) && mode.directionSound !== false;
}

/** 練習の選択肢と、そこで選んだ値。 */
export interface ModeOptionSelection {
  readonly option: ModeOption;
  readonly choice: ModeOptionChoice;
}

/**
 * 選んだ値（選択肢の id → 値の id）から、モードの練習の選択肢ごとの値を決める。並びはモードの options の順。
 * 持たないモードでは空、選択肢にない値と渡されなかった選択肢は既定の値。
 */
export function modeOptionChoices(
  mode: Pick<TrainingMode, 'options'>,
  given: Readonly<Record<string, string | undefined>> = {},
): ModeOptionSelection[] {
  return (mode.options ?? []).map((option) => {
    const id = given[option.id];
    const choice = option.choices.find((c) => c.id === id) ?? option.choices.find((c) => c.id === option.defaultChoice) ?? option.choices[0];
    if (!choice) throw new Error(`practice option ${option.id} has no choices`);
    return { option, choice };
  });
}

/** 練習の選択肢ごとの値を、選択肢の id → 値の id の形にする。 */
export function modeOptionValues(selections: readonly ModeOptionSelection[]): ModeOptionValues {
  return Object.fromEntries(selections.map((s) => [s.option.id, s.choice.id]));
}
