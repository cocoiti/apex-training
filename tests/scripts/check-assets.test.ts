import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/check-assets.mjs');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

type Entry = Partial<Record<'path' | 'author' | 'license' | 'source', unknown>>;

const own = (path: string): Entry => ({ path, author: '自作', license: 'self-made', source: 'Inkscape で描いた' });
const oss = (path: string, license = 'CC0-1.0'): Entry => ({
  path,
  author: 'Kenney',
  license,
  source: 'https://kenney.nl/assets/ui-pack から入手した',
});

/**
 * リポジトリに見立てたフォルダを作る。scripts/check-assets.mjs の写し、素材の一覧（manifest が null なら置かない、
 * 文字列ならそのまま書く）、sources のパスの空のファイル、ビルドの結果に見立てた dist/（dist のパスに空のファイル）を置く。
 */
function repoWith({ manifest = [], sources = [], dist = [] }: { manifest?: unknown; sources?: string[]; dist?: string[] }) {
  const repo = mkdtempSync(join(tmpdir(), 'check-assets-'));
  temps.push(repo);
  cpSync(SCRIPT, join(repo, 'scripts/check-assets.mjs'));
  const put = (file: string, content = '') => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), content);
  };
  if (manifest !== null) put('src/assets/assets.json', typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const file of sources) put(file);
  for (const file of ['index.html', 'assets/index.js', 'assets/index.css', 'assets/range.json', ...dist]) put(join('dist', file));
  return repo;
}

/** 引数（dir）を渡さなければ、リポジトリの dist/ を調べる。 */
function check(repo: string, dir?: string) {
  const args = [join(repo, 'scripts/check-assets.mjs'), ...(dir ? [dir] : [])];
  const result = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('配布物の検査: 成功するとき（OVR-2）', () => {
  it('一覧が空の配列で、画像・音声・3D モデルのファイルがなければ成功する', () => {
    const result = check(repoWith({}));
    expect(result.status, result.output).toBe(0);
  });

  it('一覧に載った src/ の素材は、ハッシュ付きの名前でビルド結果にあっても成功する', () => {
    const repo = repoWith({
      manifest: [own('src/assets/icons/play.svg'), own('src/assets/sfx/shot-fx.wav')],
      sources: ['src/assets/icons/play.svg', 'src/assets/sfx/shot-fx.wav'],
      dist: ['assets/play-D-d_14rf.svg', 'assets/shot-fx-CoIjuEbI.wav'],
    });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it('一覧に載った public/ の素材は、ビルド結果のルートからの同じパスにあれば成功する', () => {
    const repo = repoWith({
      manifest: [own('public/favicon.svg'), own('public/models/target.glb')],
      sources: ['public/favicon.svg', 'public/models/target.glb'],
      dist: ['favicon.svg', 'models/target.glb'],
    });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it('拡張子の大文字・小文字は区別せずに一覧と照らす', () => {
    const repo = repoWith({ manifest: [own('src/assets/a.PNG')], sources: ['src/assets/a.PNG'], dist: ['assets/a-12345678.PNG'] });
    expect(check(repo).status).toBe(0);
  });
});

describe('配布物の検査: 一覧に載っていないファイル（OVR-10）', () => {
  it.each(['assets/unknown.png', 'favicon.ico', 'icons/mark.svg', 'sfx/shot.wav', 'sfx/shot.OGG', 'models/r301.glb', 'models/r301.gltf'])(
    '%s があればそのパスと一覧に載っていない旨を示して失敗する',
    (file) => {
      const result = check(repoWith({ dist: [file] }));
      expect(result.status).toBe(1);
      expect(result.output).toContain(`${file}: `);
      expect(result.output).toContain('一覧に載っていない');
    },
  );

  it('複数あればすべてのパスを示し、ほかのファイルは示さない', () => {
    const result = check(repoWith({ dist: ['a.jpg', 'deep/b.mp3', 'deep/er/c.fbx'] }));
    expect(result.status).toBe(1);
    for (const file of ['a.jpg', 'deep/b.mp3', 'deep/er/c.fbx']) expect(result.output).toContain(file);
    expect(result.output).not.toContain('index.js');
  });

  it('public/ の素材は、ルートからのパスが違えば載っていないとみなす', () => {
    const repo = repoWith({ manifest: [own('public/favicon.svg')], sources: ['public/favicon.svg'], dist: ['icons/favicon.svg'] });
    const result = check(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('icons/favicon.svg: 画像のファイルが素材の一覧に載っていない');
  });

  it('ハッシュを除いた名前か拡張子が一覧のファイル名と違えば載っていないとみなす', () => {
    const repo = repoWith({
      manifest: [own('src/assets/play.svg')],
      sources: ['src/assets/play.svg'],
      dist: ['assets/pause-D-d_14rf.svg', 'assets/play-D-d_14rf.png'],
    });
    const result = check(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('pause-D-d_14rf.svg');
    expect(result.output).toContain('play-D-d_14rf.png');
  });

  it('引数を渡さなければリポジトリの dist/ を調べる', () => {
    const result = check(repoWith({ dist: ['assets/unknown.png'] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(join('dist', 'assets', 'unknown.png'));
  });

  it('調べるフォルダがなければ失敗する', () => {
    const repo = repoWith({});
    const result = check(repo, join(repo, 'missing'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('npm run build');
  });
});

describe('配布物の検査: 許可したライセンス（OVR-15〜OVR-18）', () => {
  it('一覧の項目の license がすべて self-made なら、source に URL がなくても成功する（OVR-15）', () => {
    const repo = repoWith({
      manifest: [own('src/assets/a.png'), { ...own('public/b.wav'), license: '  self-made  ' }],
      sources: ['src/assets/a.png', 'public/b.wav'],
      dist: ['assets/a-12345678.png', 'b.wav'],
    });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it('license が CC0-1.0 で source に https:// の配布元の URL があれば成功する（OVR-16）', () => {
    const repo = repoWith({ manifest: [oss('src/assets/a.png'), own('src/assets/b.png')], sources: ['src/assets/a.png', 'src/assets/b.png'] });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it.each(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'OFL-1.1'])(
    'OSS 系の %s は source に URL があれば成功する',
    (license) => {
      const repo = repoWith({ manifest: [oss('src/assets/a.png', license)], sources: ['src/assets/a.png'] });
      const result = check(repo);
      expect(result.status, result.output).toBe(0);
    },
  );

  it.each(['Proprietary', 'cc0-1.0', 'mit', 'Self-made', '自作', 'MIT OR Apache-2.0', 'CC0', 'CC-BY-NC-4.0', 'GPL-3.0-only'])(
    'license が %j ならその path と許可していないライセンスである旨とその値を示して失敗する（OVR-17）',
    (license) => {
      const repo = repoWith({ manifest: [{ ...oss('src/assets/a.png'), license }], sources: ['src/assets/a.png'] });
      const result = check(repo);
      expect(result.status).toBe(1);
      expect(result.output).toContain(`src/assets/a.png: 許可していないライセンス（license: ${JSON.stringify(license)}）`);
    },
  );

  it('許可していないライセンスの項目が複数あればすべて示す', () => {
    const repo = repoWith({
      manifest: [{ ...own('src/assets/a.png'), license: 'Proprietary' }, { ...own('src/assets/b.png'), license: 'cc0-1.0' }],
      sources: ['src/assets/a.png', 'src/assets/b.png'],
    });
    const result = check(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('src/assets/a.png: 許可していないライセンス');
    expect(result.output).toContain('src/assets/b.png: 許可していないライセンス');
  });

  it.each([
    ['author', 'Respawn Entertainment'],
    ['author', 'EA'],
    ['author', 'Electronic Arts'],
    ['source', 'Apex Legends の画面を参考に Inkscape で描いた'],
    ['source', 'RESPAWN の配色を真似ずに描いた'],
    ['source', 'Creative Commons の素材集'],
  ])('%s が %j でも、license が許可した値でほかの条件に当たらなければ成功する（OVR-18）', (key, value) => {
    const repo = repoWith({ manifest: [{ ...own('src/assets/a.png'), [key]: value }], sources: ['src/assets/a.png'] });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });
});

describe('配布物の検査: OSS 系のライセンスの配布元の URL（OVR-19）', () => {
  it.each(['Kenney の UI Pack から入手した', 'kenney.nl から入手した', 'ftp://example.com/a.png', 'https://', 'HTTPS://example.com'])(
    'license が MIT で source が %j ならその path と配布元の URL がない旨を示して失敗する',
    (source) => {
      const repo = repoWith({ manifest: [{ ...oss('src/assets/a.png', 'MIT'), source }], sources: ['src/assets/a.png'] });
      const result = check(repo);
      expect(result.status).toBe(1);
      expect(result.output).toContain('src/assets/a.png: license が MIT なのに source に配布元の URL');
      expect(result.output).toContain('がない');
    },
  );

  it.each(['http://example.com/a.png', '配布元: https://opengameart.org/content/a（2026-11-25 に入手）'])('source が %j なら成功する', (source) => {
    const repo = repoWith({ manifest: [{ ...oss('src/assets/a.png', 'MIT'), source }], sources: ['src/assets/a.png'] });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it('source が空なら必須の項目の欠けだけを示し、URL の欠けは重ねて示さない', () => {
    const repo = repoWith({ manifest: [{ ...oss('src/assets/a.png', 'MIT'), source: '' }], sources: ['src/assets/a.png'] });
    const result = check(repo);
    expect(result.status).toBe(1);
    expect(result.output).toContain('必須の項目 source がない');
    expect(result.output).not.toContain('配布元の URL');
  });
});

describe('配布物の検査: 必須の項目（OVR-12）', () => {
  it.each(['path', 'author', 'license', 'source'] as const)('%s がない項目は、欠けている項目の名前を示して失敗する', (key) => {
    const entry = own('src/assets/a.png');
    delete entry[key];
    const result = check(repoWith({ manifest: [entry], sources: ['src/assets/a.png'] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(key === 'path' ? '1 番目' : 'src/assets/a.png');
    expect(result.output).toContain(`必須の項目 ${key} がない`);
  });

  it.each(['', '  ', 0, null])('license が %j の項目は、その path と license を示して失敗する', (license) => {
    const result = check(repoWith({ manifest: [{ ...own('src/assets/a.png'), license }], sources: ['src/assets/a.png'] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('src/assets/a.png: 必須の項目 license がない、または空の文字列');
  });

  it('複数の項目が欠けていればすべて示す', () => {
    const result = check(repoWith({ manifest: [{ path: 'src/assets/a.png', author: '自作' }], sources: ['src/assets/a.png'] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('必須の項目 license・source がない');
  });

  it('項目がオブジェクトでなければ何番目かを示して失敗する', () => {
    const result = check(repoWith({ manifest: [own('src/assets/a.png'), 'src/assets/b.png'], sources: ['src/assets/a.png'] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('2 番目: 項目がオブジェクトでない');
  });
});

describe('配布物の検査: 一覧の path のファイル（OVR-13）', () => {
  it.each(['src/assets/missing.png', '../outside.png', '/etc/hosts.png', 'src/assets'])(
    'path が %j ならその path とファイルがない旨を示して失敗する',
    (path) => {
      const result = check(repoWith({ manifest: [own(path)], sources: ['src/assets/a.png'] }));
      expect(result.status).toBe(1);
      expect(result.output).toContain(`${path}: ファイルがリポジトリにない`);
    },
  );

  it('path が対象の拡張子でなければ失敗する', () => {
    const result = check(repoWith({ manifest: [own('src/assets/notes.txt')], sources: ['src/assets/notes.txt'] }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('src/assets/notes.txt: 画像・音声・3D モデルの拡張子でない');
  });
});

describe('配布物の検査: 素材の一覧のファイル', () => {
  it.each([
    ['ない', null, '素材の一覧のファイルがない'],
    ['JSON として読めない', '[{', '素材の一覧が JSON として読めない'],
    ['配列でない', '{}', '素材の一覧が配列でない'],
  ])('一覧が%sときは失敗する', (_, manifest, message) => {
    const result = check(repoWith({ manifest }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(`src/assets/assets.json: ${message}`);
  });
});

describe('ビルド: 画像を data: URL に埋め込まずファイルとして出す（OVR-14）', () => {
  function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));
  }

  it('src/ から読み込んだ小さな画像はビルド結果のファイルになり、一覧に載っていれば検査が成功する', async () => {
    const repo = repoWith({ manifest: [own('src/assets/dot.svg')], sources: [] });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    mkdirSync(join(repo, 'src/assets'), { recursive: true });
    writeFileSync(join(repo, 'src/assets/dot.svg'), svg);
    writeFileSync(join(repo, 'src/main.js'), `import dot from './assets/dot.svg';\ndocument.body.style.background = \`url(\${dot})\`;\n`);
    writeFileSync(join(repo, 'index.html'), '<!doctype html><script type="module" src="/src/main.js"></script>');
    rmSync(join(repo, 'dist'), { recursive: true, force: true });

    await build({ configFile: join(ROOT, 'vite.config.ts'), root: repo, logLevel: 'silent', build: { outDir: join(repo, 'dist') } });

    const files = filesUnder(join(repo, 'dist'));
    expect(files.filter((f) => /dot-[\w-]{8}\.svg$/.test(f))).toHaveLength(1);
    for (const file of files.filter((f) => /\.(js|css|html)$/.test(f))) expect(readFileSync(file, 'utf8')).not.toContain('data:image');
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  }, 60_000);
});
