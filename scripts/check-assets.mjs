// 配布物（ビルドの結果）の画像・音声・3D モデルが、出どころを素材の一覧（src/assets/assets.json）に記録したものだけであることと、
// 一覧の記載に欠けや公式の名前がないことを確かめる（docs/spec/overview.md「素材の一覧」、OVR-2・OVR-10〜OVR-14）。
// 当たったファイルのパスか一覧の項目と理由をすべて示して失敗する。調べるフォルダは引数で渡せる（既定は dist/）。
// 先に npm run build を実行しておく。一覧の path はこのスクリプトのあるリポジトリのルートから解決する。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// 拡張子の一覧は docs/spec/overview.md「素材の一覧」と揃える。
const KINDS = {
  画像: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  音声: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  '3D モデル': ['glb', 'gltf', 'fbx', 'obj', 'dae', '3ds', 'blend', 'usdz'],
};
const KIND_BY_EXT = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])));
const REQUIRED = ['path', 'author', 'license', 'source'];
// 公式を示す名前。「EA」は英字の単語として現れたときだけ当たる（「Creative」では当たらない）。
const OFFICIAL = [
  ['EA', /(?<![a-z])ea(?![a-z])/i],
  ['Electronic Arts', /electronic\s+arts/i],
  ['Respawn', /respawn/i],
  ['Apex Legends', /apex\s+legends/i],
];
// ビルドが付けるハッシュ（`<名前>-<ハッシュ>.<拡張子>` の `-<ハッシュ>`）。
const BUILD_HASH = /-[A-Za-z0-9_-]{8}$/;

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = 'src/assets/assets.json';

const show = (path) => relative(process.cwd(), path) || path;
const kindOf = (path) => KIND_BY_EXT.get(extname(path).slice(1).toLowerCase());

const target = resolve(process.argv[2] ?? join(ROOT, 'dist'));
if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`${show(target)} がない。先に npm run build を実行する。`);
  process.exit(1);
}

/** フォルダの下のファイルを再帰的に列挙する。 */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** 素材の一覧を読む。読めなければ理由を problems に足して空の一覧を返す。 */
function readManifest(problems) {
  const file = join(ROOT, MANIFEST);
  if (!existsSync(file)) {
    problems.push(`${MANIFEST}: 素材の一覧のファイルがない`);
    return [];
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${MANIFEST}: 素材の一覧が JSON として読めない（${error.message}）`);
    return [];
  }
  if (!Array.isArray(data)) {
    problems.push(`${MANIFEST}: 素材の一覧が配列でない`);
    return [];
  }
  return data;
}

/** 一覧の 1 項目を調べ、理由を problems に足す。項目を示すのは path（なければ何番目か）。 */
function checkEntry(entry, index, problems) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    problems.push(`${MANIFEST} の ${index + 1} 番目: 項目がオブジェクトでない`);
    return;
  }
  const hasPath = typeof entry.path === 'string' && entry.path !== '';
  const label = hasPath ? entry.path : `${MANIFEST} の ${index + 1} 番目`;
  const missing = REQUIRED.filter((key) => typeof entry[key] !== 'string' || entry[key].trim() === '');
  if (missing.length > 0) problems.push(`${label}: 必須の項目 ${missing.join('・')} がない、または空の文字列`);
  for (const key of ['author', 'source']) {
    if (typeof entry[key] !== 'string') continue;
    for (const [name, pattern] of OFFICIAL) {
      if (pattern.test(entry[key])) problems.push(`${label}: ${key} に公式の名前（${name}）が入っている`);
    }
  }
  if (!hasPath) return;
  const file = resolve(ROOT, entry.path);
  const inside = !isAbsolute(entry.path) && !relative(ROOT, file).startsWith('..');
  if (!inside || !existsSync(file) || !statSync(file).isFile()) problems.push(`${label}: ファイルがリポジトリにない`);
  else if (!kindOf(file)) problems.push(`${label}: 画像・音声・3D モデルの拡張子でない`);
}

const problems = [];
const entries = readManifest(problems);
entries.forEach((entry, index) => checkEntry(entry, index, problems));

// 一覧に載っているとみなすビルド結果のパス（public/ の下の素材）と、ファイル名（それ以外の素材）。
const paths = entries.flatMap((entry) => (typeof entry?.path === 'string' && entry.path !== '' ? [entry.path.split(sep).join('/')] : []));
const publicPaths = new Set(paths.filter((p) => p.startsWith('public/')).map((p) => p.slice('public/'.length)));
const sourceNames = new Set(paths.filter((p) => !p.startsWith('public/')).map((p) => basename(p)));

/** ビルド結果のファイル（target からの相対パス）が一覧に載っているか。 */
function isListed(rel) {
  if (publicPaths.has(rel)) return true;
  const name = basename(rel);
  const ext = extname(name);
  return sourceNames.has(name) || sourceNames.has(`${name.slice(0, -ext.length).replace(BUILD_HASH, '')}${ext}`);
}

const unlisted = [];
for (const file of walk(target)) {
  const kind = kindOf(file);
  if (kind && !isListed(relative(target, file).split(sep).join('/'))) unlisted.push(`${show(file)}: ${kind}のファイルが素材の一覧に載っていない`);
}
problems.push(...unlisted.sort());

if (problems.length > 0) {
  console.error(`配布物の素材の検査で問題が見つかった:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`${show(target)} の画像・音声・3D モデルはすべて素材の一覧（${MANIFEST}、${entries.length} 件）に載っている`);
