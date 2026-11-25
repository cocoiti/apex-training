/**
 * 武器の JSON の一覧と取得。シミュレーションの外で JSON を取得し、中身の確認は sim の buildWeaponList で行う。
 * JSON は Vite の資産として出し、URL はビルド時のベースパス基準になる（docs/adr/2026-11-25-data-json-as-fetched-assets.md）。
 * このディレクトリに JSON を足すと、コードを変えずに武器の一覧に出る（docs/spec/weapons.md WPN-1）。
 */
import { buildWeaponList, type RejectedWeapon, type WeaponData, type WeaponFile } from '../../sim/weapon';

const urls = import.meta.glob<string>('./*.json', { query: '?url', import: 'default', eager: true });

/** 武器の JSON のファイル名と URL。並びはファイル名の順。 */
export const weaponUrls: readonly { readonly file: string; readonly url: string }[] = Object.entries(urls)
  .map(([path, url]) => ({ file: path.replace(/^\.\//, ''), url }))
  .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

export type FetchJson = (url: string) => Promise<unknown>;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`取得できない（${response.status}）`);
  return response.json();
}

/** 一覧から外した武器を開発者向けに出力する（ファイル名と誤りの項目）。 */
export function reportRejectedWeapons(rejected: readonly RejectedWeapon[], log: (message: string) => void = console.error): void {
  for (const { file, errors } of rejected) {
    const detail = errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join(' / ');
    log(`武器のデータ ${file} を読み込めないので一覧から外す: ${detail}`);
  }
}

export interface LoadWeaponsOptions {
  files?: readonly { readonly file: string; readonly url: string }[];
  fetchJson?: FetchJson;
  log?: (message: string) => void;
}

/**
 * 武器の JSON をすべて取得して武器の一覧を作る。誤りのある JSON と取得できない JSON は一覧から外して出力し、ほかの武器は返す。
 */
export async function loadWeapons(options: LoadWeaponsOptions = {}): Promise<WeaponData[]> {
  const { files = weaponUrls, fetchJson: fetcher = fetchJson, log = console.error } = options;
  const fetched = await Promise.all(
    files.map(async ({ file, url }) => {
      try {
        return { file, json: await fetcher(url) } satisfies WeaponFile;
      } catch (error) {
        return { file, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  const readable: WeaponFile[] = [];
  const unreadable: RejectedWeapon[] = [];
  for (const entry of fetched) {
    if ('error' in entry) unreadable.push({ file: entry.file, errors: [{ path: '', message: entry.error }] });
    else readable.push(entry);
  }
  const list = buildWeaponList(readable);
  reportRejectedWeapons([...unreadable, ...list.rejected], log);
  return [...list.weapons];
}
