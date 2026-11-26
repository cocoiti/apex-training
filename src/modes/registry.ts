/**
 * 練習モードの一覧。`src/modes/<category>/*.ts` のモードのファイルをビルド時に集める（docs/spec/modes.md「モードの登録」）。
 * ファイルを 1 つ足せば、ほかのファイルを変えずにトップ画面の選択肢に出る（MODE-5）。
 * 決定の理由は docs/adr/2026-11-25-mode-files-by-glob.md。
 */
import { MODE_ICONS, type ModeCategory, type ModeIcon, type TrainingMode } from './types';

/** モードのファイル 1 つ分。file はファイルのパス（並び順が同じときの順と、開発者向けの出力に使う）。 */
export interface ModeModule {
  readonly file: string;
  readonly module: { readonly default?: unknown };
}

const CATEGORIES: readonly ModeCategory[] = ['recoil', 'aim', 'movement', 'combined'];

/** 保存の形で使っている項目名。比べる指標と保存する指標の id には使えない（docs/spec/scoring.md「保存の形」）。 */
const RESERVED_FIELDS = ['version', 'achievedAt', 'at'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 両方の言語の文言の形（docs/spec/modes.md「モードの登録」）。どちらも文字列。 */
function isLocalized(value: unknown): boolean {
  return isRecord(value) && typeof value.ja === 'string' && typeof value.en === 'string';
}

function isMetric(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    !RESERVED_FIELDS.includes(value.id) &&
    typeof value.label === 'string' &&
    typeof value.unit === 'string' &&
    typeof value.format === 'function'
  );
}

/** 採点の仕方の形。省いたモードは弾痕のズレの採点。 */
function isScoring(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || typeof value.score !== 'function') return false;
  const compare = value.compare;
  if (!isMetric(compare) || !isRecord(compare)) return false;
  if (compare.better !== 'lower' && compare.better !== 'higher') return false;
  if (compare.valid !== undefined && typeof compare.valid !== 'function') return false;
  return value.columns === undefined || (Array.isArray(value.columns) && value.columns.every(isMetric));
}

/** 保存のキーに足せる値の id（docs/spec/scoring.md「保存の形」）。キーの区切りの `:` を含まない。 */
const OPTION_ID = /^[a-z0-9-]+$/;

/** 練習の選択肢の 1 つの形。値の id は重ならず、既定の値は値のどれか。 */
function isOption(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || !isLocalized(value.label)) return false;
  const { choices, defaultChoice } = value;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const ids = choices.map((c: unknown) => (isRecord(c) && isLocalized(c.name) && typeof c.id === 'string' && OPTION_ID.test(c.id) ? c.id : undefined));
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) return false;
  return typeof defaultChoice === 'string' && ids.includes(defaultChoice);
}

/** 練習の選択肢の並びの形。省いたモードは持たない。選択肢の id は重ならない。 */
function isOptions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every(isOption)) return false;
  return new Set(value.map((o: { id: string }) => o.id)).size === value.length;
}

const optional = (value: unknown, type: 'boolean' | 'function') => value === undefined || typeof value === type;

function isTrainingMode(value: unknown): value is TrainingMode {
  if (typeof value !== 'object' || value === null) return false;
  const mode = value as Record<string, unknown>;
  return (
    typeof mode.id === 'string' &&
    isLocalized(mode.name) &&
    isLocalized(mode.description) &&
    MODE_ICONS.includes(mode.icon as ModeIcon) &&
    CATEGORIES.includes(mode.category as ModeCategory) &&
    typeof mode.order === 'number' &&
    Number.isFinite(mode.order) &&
    ['setup', 'step', 'result', 'teardown'].every((key) => typeof mode[key] === 'function') &&
    optional(mode.ghost, 'function') &&
    optional(mode.status, 'function') &&
    optional(mode.usesWeapon, 'boolean') &&
    optional(mode.weakSections, 'boolean') &&
    optional(mode.directionSound, 'boolean') &&
    optional(mode.refillOnRelease, 'boolean') &&
    isOptions(mode.options) &&
    (mode.timeLimit === undefined || (typeof mode.timeLimit === 'number' && Number.isFinite(mode.timeLimit) && mode.timeLimit > 0)) &&
    isScoring(mode.scoring)
  );
}

/**
 * モードのファイルの集まりからモードの一覧を作る。並びは order の順、同じならファイルのパスの順。
 * default がモードの形でないファイルと、先に出たモードと id が重なるファイルは外して開発者向けに出力する。
 */
export function buildModeList(modules: readonly ModeModule[], log: (message: string) => void = console.error): TrainingMode[] {
  const sorted = [...modules].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const modes: { file: string; mode: TrainingMode }[] = [];
  const seen = new Set<string>();
  for (const { file, module } of sorted) {
    const mode = module.default;
    if (!isTrainingMode(mode)) {
      log(`mode file ${file}: the default export is not a training mode, so it is left out of the list`);
    } else if (seen.has(mode.id)) {
      log(`mode file ${file}: the mode id "${mode.id}" is a duplicate, so it is left out of the list`);
    } else {
      seen.add(mode.id);
      modes.push({ file, mode });
    }
  }
  // sort は安定なので、order が同じモードはファイルのパスの順のまま残る。
  return modes.sort((a, b) => a.mode.order - b.mode.order).map(({ mode }) => mode);
}

const found = import.meta.glob<{ default?: unknown }>('./*/*.ts', { eager: true });

/** 登録されたモード。トップ画面のモードの選択肢はこの順に並ぶ。 */
export const modes: readonly TrainingMode[] = buildModeList(
  Object.entries(found).map(([path, module]) => ({ file: path.replace(/^\.\//, ''), module })),
);
