// 配布物（ビルドの結果）に画像・音声・3D モデルの形式のファイルが含まれていないことを確かめる（docs/spec/overview.md OVR-2）。
// 見つかったらそのパスを示して失敗する。調べるフォルダは引数で渡せる（既定は dist/）。先に npm run build を実行しておく。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

// 拡張子の一覧は docs/spec/overview.md「権利と表記」と揃える。
const FORBIDDEN = {
  画像: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  音声: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  '3D モデル': ['glb', 'gltf', 'fbx', 'obj', 'dae', '3ds', 'blend', 'usdz'],
};
const KIND_BY_EXT = new Map(Object.entries(FORBIDDEN).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])));

const target = resolve(process.argv[2] ?? join(import.meta.dirname, '..', 'dist'));
if (!existsSync(target) || !statSync(target).isDirectory()) {
  console.error(`${relative(process.cwd(), target) || target} がない。先に npm run build を実行する。`);
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

const found = [];
for (const file of walk(target)) {
  const kind = KIND_BY_EXT.get(extname(file).slice(1).toLowerCase());
  if (kind) found.push(`${kind}: ${relative(process.cwd(), file)}`);
}

if (found.length > 0) {
  console.error(`配布物に画像・音声・3D モデルのファイルがある:\n${found.sort().join('\n')}`);
  process.exit(1);
}
console.log(`${relative(process.cwd(), target) || target} に画像・音声・3D モデルのファイルはない`);
