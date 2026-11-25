/**
 * マップの JSON の一覧と取得。シミュレーションの外で JSON を取得し、中身を sim の loadWorld に渡す。
 * JSON は Vite の資産として出し、URL はビルド時のベースパス基準になる（docs/adr/2026-11-25-data-json-as-fetched-assets.md）。
 */
const urls = import.meta.glob<string>('./*.json', { query: '?url', import: 'default', eager: true });

/** マップの識別子（ファイル名）から JSON の URL を引く。 */
export const mapUrls: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(urls).map(([path, url]) => [path.replace(/^\.\/(.*)\.json$/, '$1'), url]),
);

/** マップの JSON の中身を取得する。 */
export async function fetchMapJson(id: string): Promise<unknown> {
  const url = mapUrls[id];
  if (url === undefined) throw new Error(`マップ "${id}" がない`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`マップ "${id}" を取得できない（${response.status}）`);
  return response.json();
}
