/** 画面の識別子。docs/spec/screens.md の画面の表に対応する。 */
export type ScreenId = 'top' | 'settings' | 'settings-pad' | 'play' | 'result';

/** 画面ごとのハッシュ。 */
export const SCREEN_HASHES: Readonly<Record<ScreenId, string>> = {
  top: '#/',
  settings: '#/settings',
  'settings-pad': '#/settings/pad',
  play: '#/play',
  result: '#/result',
};

const SCREEN_BY_PATH: ReadonlyMap<string, ScreenId> = new Map(
  (Object.entries(SCREEN_HASHES) as [ScreenId, string][]).map(([id, hash]) => [hash.slice(1), id]),
);

/**
 * ハッシュから画面を引く。末尾のスラッシュは無視する。
 * どの画面にも当たらないハッシュ（ハッシュなしを含む）はトップ画面にする（OVR-6）。
 */
export function screenFromHash(hash: string): ScreenId {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '');
  return SCREEN_BY_PATH.get(path === '' ? '/' : path) ?? 'top';
}

/** ハッシュの変更を受け取れるもの。ブラウザでは window。 */
export interface HashSource {
  readonly location: { readonly hash: string };
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

/** 今のハッシュの画面ですぐに 1 回呼び、以後はハッシュが変わるたびに呼ぶ。外すための関数を返す。 */
export function watchScreen(source: HashSource, onScreen: (screen: ScreenId) => void): () => void {
  const notify = () => onScreen(screenFromHash(source.location.hash));
  source.addEventListener('hashchange', notify);
  notify();
  return () => source.removeEventListener('hashchange', notify);
}
