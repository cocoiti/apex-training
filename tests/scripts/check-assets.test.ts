import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/check-assets.mjs');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** ビルドの結果に見立てたフォルダを作り、files のパスに空のファイルを置く。 */
function distWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-assets-'));
  temps.push(dir);
  for (const file of ['index.html', 'assets/index.js', 'assets/index.css', 'assets/range.json', ...files]) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), '');
  }
  return dir;
}

function check(dir: string) {
  const result = spawnSync(process.execPath, [SCRIPT, dir], { cwd: join(dir, '..'), encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('配布物の検査（OVR-2）', () => {
  it('画像・音声・3D モデルのファイルがなければ成功する', () => {
    const result = check(distWith([]));
    expect(result.status, result.output).toBe(0);
  });

  it.each(['assets/logo.png', 'favicon.ico', 'icons/mark.svg', 'sfx/shot.wav', 'sfx/shot.OGG', 'models/r301.glb', 'models/r301.gltf'])(
    '%s があればそのパスを示して失敗する',
    (file) => {
      const result = check(distWith([file]));
      expect(result.status).toBe(1);
      expect(result.output).toContain(file);
    },
  );

  it('複数あればすべてのパスを示す', () => {
    const result = check(distWith(['a.jpg', 'deep/b.mp3', 'deep/er/c.fbx']));
    expect(result.status).toBe(1);
    for (const file of ['a.jpg', 'deep/b.mp3', 'deep/er/c.fbx']) expect(result.output).toContain(file);
    expect(result.output).not.toContain('index.js');
  });

  it('調べるフォルダがなければ失敗する', () => {
    const dir = distWith([]);
    const result = check(join(dir, 'missing'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('npm run build');
  });
});
