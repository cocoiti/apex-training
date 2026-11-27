// docs/spec/screens.md「3D の表示」の人型の板の配布物（UI-138）の受け入れテスト（#90, #95）。
// 人型の板の形・当たり・描画（ARC-63〜ARC-66・ARC-74・ARC-75、MODE-51・MODE-59〜MODE-65、UI-136・UI-139）は
// tests/sim/humanoid.test.ts・tests/modes/・tests/render/targets.test.ts で確かめる。ブラウザで確かめるものは humanoid-dummy-browser-qa.acceptance.test.ts にある。
// 公開された入口（npm run build・npm run check:assets、src/assets/assets.json）だけを使う。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

describe('UI-138: 人型の板のための素材のファイルがない配布物', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  });

  it('ビルドの配布物に画像・音声・3D モデルのファイルがなく（人型の板の見た目はコードで作る）、npm run build のあとの npm run check:assets が成功する', () => {
    const out = mkdtempSync(join(tmpdir(), 'ui138-dist-'));
    temps.push(out);
    const env = { ...process.env, FORCE_COLOR: '0', APEX_ACCEPTANCE_NESTED: '1' };
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const MEDIA = /^\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp3|wav|ogg|m4a|aac|flac|opus|weba|glb|gltf|fbx|obj|dae|3ds|blend|usdz)$/i;
    const media = walk(out).filter((f) => MEDIA.test(extname(f)));
    // 素材の一覧に載っていないものも、人型の板・人形の名前のものもない。
    const manifest = JSON.parse(readFileSync(join(ROOT, 'src/assets/assets.json'), 'utf8')) as { path?: string }[];
    expect(media.filter((f) => /dummy|humanoid|mannequin|doll|silhouette|人形|人型/i.test(f))).toEqual([]);
    expect(manifest.filter((e) => /dummy|humanoid|mannequin|doll|silhouette|人形|人型/i.test(JSON.stringify(e)))).toEqual([]);
    expect(media.map((f) => f.slice(out.length))).toEqual([]);
    const check = spawnSync(`npm run check:assets -- "${out}"`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
  }, 300_000);
});
