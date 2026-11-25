/**
 * 練習モードの一覧。`src/modes/<category>/*.ts` のモードのファイルをビルド時に集める（docs/spec/modes.md「モードの登録」）。
 * ファイルを 1 つ足せば、ほかのファイルを変えずにトップ画面の選択肢に出る（MODE-5）。
 * 決定の理由は docs/adr/2026-11-25-mode-files-by-glob.md。
 */
import type { ModeCategory, TrainingMode } from './types';

/** モードのファイル 1 つ分。file はファイルのパス（並び順が同じときの順と、開発者向けの出力に使う）。 */
export interface ModeModule {
  readonly file: string;
  readonly module: { readonly default?: unknown };
}

const CATEGORIES: readonly ModeCategory[] = ['recoil', 'movement', 'combined'];

function isTrainingMode(value: unknown): value is TrainingMode {
  if (typeof value !== 'object' || value === null) return false;
  const mode = value as Record<string, unknown>;
  return (
    typeof mode.id === 'string' &&
    typeof mode.name === 'string' &&
    CATEGORIES.includes(mode.category as ModeCategory) &&
    typeof mode.order === 'number' &&
    Number.isFinite(mode.order) &&
    ['setup', 'step', 'result', 'teardown'].every((key) => typeof mode[key] === 'function')
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
      log(`モードのファイル ${file} の default が練習モードの形でないので一覧から外す`);
    } else if (seen.has(mode.id)) {
      log(`モードのファイル ${file} のモードの ID "${mode.id}" が重複しているので一覧から外す`);
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
