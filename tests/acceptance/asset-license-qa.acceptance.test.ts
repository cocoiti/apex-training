// docs/spec/overview.md「素材の一覧」「許可するライセンス」の受け入れ条件（OVR-2 の変更・OVR-10・OVR-12・OVR-15〜OVR-19。
// OVR-11 は削除して欠番）の QA の受け入れテスト（#32）。
// 公開された入口（npm run check:assets、npm run build、素材の一覧 src/assets/assets.json）だけを使い、
// 期待値は SPEC の文から求める。リポジトリを書き換えないよう、一時ディレクトリの写しで実行する。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const MANIFEST = 'src/assets/assets.json';

/** SPEC の「許可するライセンス」の表の値。 */
const ALLOWED = ['self-made', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'OFL-1.1'];
const OSS = ALLOWED.filter((v) => v !== 'self-made');
const NOT_ALLOWED = '許可していないライセンス';
const NOT_LISTED = '一覧に載っていない';

type Entry = Partial<Record<'path' | 'author' | 'license' | 'source', unknown>>;

const temps: string[] = [];
let dist = '';

function run(command: string, cwd: string) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const svg = (n: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}"/>`;

function selfMade(path: string, extra: Entry = {}): Entry {
  return { path, author: '自作', license: 'self-made', source: 'QA の受け入れテストで手書きした SVG', ...extra };
}

function oss(path: string, license: string, extra: Entry = {}): Entry {
  return { path, author: 'Jane Doe', license, source: `配布元 https://example.com/assets/${license}.svg を取得`, ...extra };
}

/**
 * 検査のコマンドを実行するためのリポジトリの写しを作る（package.json・scripts/・src/ と、ビルドの結果の dist/）。
 * 一覧の項目の path のファイルは src/ に置き、ビルドの結果にはハッシュ付きの名前で置く（assets のとき。ハッシュは Vite と同じ 8 文字）。
 */
function repoCopy(options: { manifest: unknown; files?: Record<string, string>; distFiles?: Record<string, string> }) {
  const repo = temp('ovr-lic-repo-');
  for (const name of ['package.json', 'scripts', 'src']) cpSync(join(ROOT, name), join(repo, name), { recursive: true });
  cpSync(dist, join(repo, 'dist'), { recursive: true });
  writeFileSync(join(repo, MANIFEST), JSON.stringify(options.manifest, null, 2));
  for (const [path, body] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  for (const [path, body] of Object.entries(options.distFiles ?? {})) {
    mkdirSync(dirname(join(repo, 'dist', path)), { recursive: true });
    writeFileSync(join(repo, 'dist', path), body);
  }
  return repo;
}

/** 一覧の項目すべてについて、ソースのファイルとビルドの結果のハッシュ付きのファイルを用意して検査する。 */
function checkWith(manifest: Entry[], extra: { distFiles?: Record<string, string> } = {}) {
  const files: Record<string, string> = {};
  const distFiles: Record<string, string> = { ...extra.distFiles };
  manifest.forEach((item, i) => {
    if (typeof item.path !== 'string' || item.path === '') return;
    files[item.path] = svg(i + 1);
    const name = item.path.split('/').pop()!;
    if (item.path.startsWith('public/')) distFiles[item.path.slice('public/'.length)] = svg(i + 1);
    else distFiles[`assets/${name.replace(/\.svg$/, '')}-Qa${i}x9Zk0.svg`] = svg(i + 1);
  });
  return run('npm run --silent check:assets', repoCopy({ manifest, files, distFiles }));
}

beforeAll(() => {
  if (NESTED) return;
  const out = temp('ovr-lic-dist-');
  const build = run(`npm run build -- --outDir "${out}" --emptyOutDir`, ROOT);
  if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.output}`);
  dist = out;
}, 300_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(NESTED)('OVR-2: 一覧に載り license が許可した値の画像だけなら（または素材なしなら）成功する', () => {
  it('素材が 1 つもなく一覧が空の配列なら成功する', () => {
    const result = run('npm run --silent check:assets', repoCopy({ manifest: [] }));
    expect(result.status, result.output).toBe(0);
  });

  it('許可するライセンスの表のすべての値の画像が載っていれば成功する', () => {
    const manifest = ALLOWED.map((license, i) =>
      license === 'self-made' ? selfMade(`src/assets/qa-ok-${i}.svg`) : oss(`src/assets/qa-ok-${i}.svg`, license),
    );
    const result = checkWith(manifest);
    expect(result.status, result.output).toBe(0);
  });

  it('public/ の下の画像も、許可した値なら成功する', () => {
    const result = checkWith([oss('public/qa-ok.svg', 'CC-BY-4.0')]);
    expect(result.status, result.output).toBe(0);
  });

  it('license の前後の空白は除いて比べる', () => {
    const result = checkWith([selfMade('src/assets/qa-a.svg', { license: '  self-made ' }), oss('src/assets/qa-b.svg', ' MIT ')]);
    expect(result.status, result.output).toBe(0);
  });

  it('対照: 一覧に載っていても license が許可していない値なら成功しない', () => {
    const result = checkWith([selfMade('src/assets/qa-a.svg'), oss('src/assets/qa-b.svg', 'GPL-3.0-only')]);
    expect(result.status, result.output).not.toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-15: license がすべて self-made なら成功する', () => {
  it('source に URL がなくても成功する', () => {
    const result = checkWith([
      selfMade('src/assets/qa-1.svg'),
      selfMade('src/assets/qa-2.svg', { source: '画像の編集ソフトで描いた' }),
      selfMade('public/qa-3.svg', { author: 'Keita Arai', source: 'プログラムで生成した' }),
    ]);
    expect(result.status, result.output).toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-16: license が CC0-1.0 で source に https:// の配布元の URL があれば成功する', () => {
  it('URL だけの source', () => {
    const result = checkWith([oss('src/assets/qa-cc0.svg', 'CC0-1.0', { source: 'https://opengameart.org/content/qa-icon' })]);
    expect(result.status, result.output).toBe(0);
  });

  it('説明の文の中に URL を含む source（自作の項目と混ざっていても成功する）', () => {
    const result = checkWith([
      selfMade('src/assets/qa-self.svg'),
      oss('src/assets/qa-cc0.svg', 'CC0-1.0', { source: 'Kenney の素材集（https://kenney.nl/assets）から色を変えずに使用' }),
    ]);
    expect(result.status, result.output).toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-17: license が許可していない値なら、path と「許可していないライセンス」とその値を示して失敗する', () => {
  for (const value of ['Proprietary', 'cc0-1.0', 'MIT OR Apache-2.0', 'mit', 'CC0', 'CC-BY-NC-4.0', 'MIT AND Apache-2.0', '(MIT)']) {
    it(`license が "${value}"`, () => {
      const path = 'src/assets/qa-bad.svg';
      const result = checkWith([selfMade('src/assets/qa-good.svg'), oss(path, value)]);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(path);
      expect(result.output).toContain(NOT_ALLOWED);
      expect(result.output).toContain(value);
      expect(result.output).not.toContain('src/assets/qa-good.svg');
    });
  }

  it('許可していない値の項目が複数あれば、すべての path と値を示す', () => {
    const result = checkWith([oss('src/assets/qa-x.svg', 'Proprietary'), oss('public/qa-y.svg', 'Self-Made')]);
    expect(result.status, result.output).not.toBe(0);
    for (const s of ['src/assets/qa-x.svg', 'Proprietary', 'public/qa-y.svg', 'Self-Made', NOT_ALLOWED]) {
      expect(result.output).toContain(s);
    }
  });
});

describe.skipIf(NESTED)('OVR-18: author や source に公式の名前があっても、license が許可した値なら成功する', () => {
  it('self-made で author と source に Respawn・EA・Apex Legends を含む', () => {
    const result = checkWith([
      selfMade('src/assets/qa-name1.svg', { author: 'Respawn', source: 'Apex Legends の画面を参考に EA の色を使わず自分で描いた' }),
      selfMade('src/assets/qa-name2.svg', { author: 'EA', source: '自作' }),
    ]);
    expect(result.status, result.output).toBe(0);
  });

  it('OSS 系の値で author・source に公式の名前と配布元の URL を含む', () => {
    const result = checkWith([
      oss('public/qa-name3.svg', 'CC-BY-4.0', {
        author: 'Electronic Arts / Respawn Entertainment',
        source: 'Apex Legends fan kit https://example.com/apex-legends/ea-respawn.svg',
      }),
    ]);
    expect(result.status, result.output).toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-19: OSS 系の値で source に http(s):// の URL がなければ、path と配布元の URL がない旨を示して失敗する', () => {
  for (const license of OSS) {
    it(`license が ${license} で source に URL がない`, () => {
      const path = 'src/assets/qa-nourl.svg';
      const result = checkWith([oss(path, license, { source: 'どこかのサイトから取得した' })]);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(path);
      expect(result.output).toMatch(/URL/);
    });
  }

  it('ftp:// や scheme のない example.com は配布元の URL とみなさない', () => {
    for (const source of ['ftp://example.com/qa.svg', 'example.com/qa.svg', 'https//example.com/qa.svg']) {
      const result = checkWith([oss('public/qa-nourl.svg', 'MIT', { source })]);
      expect(result.status, `${source}\n${result.output}`).not.toBe(0);
      expect(result.output).toContain('public/qa-nourl.svg');
      expect(result.output).toMatch(/URL/);
    }
  });

  it('対照: http:// で始まる URL があれば成功する', () => {
    const result = checkWith([oss('src/assets/qa-http.svg', 'MIT', { source: '配布元 http://example.com/qa.svg' })]);
    expect(result.status, result.output).toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-10（変更なし）: 一覧に載っていない素材がビルドの結果にあると失敗する', () => {
  it('許可した値の項目だけの一覧でも、載っていない画像があればそのパスと旨を示して失敗する', () => {
    const result = checkWith([oss('src/assets/qa-listed.svg', 'CC0-1.0')], { distFiles: { 'assets/unknown.png': 'x' } });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(['assets', 'unknown.png'].join(sep));
    expect(result.output).toContain(NOT_LISTED);
  });

  it('音声と 3D モデルも対象', () => {
    const result = checkWith([], { distFiles: { 'assets/shot.wav': 'x', 'models/gun.glb': 'x' } });
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('shot.wav');
    expect(result.output).toContain('gun.glb');
    expect(result.output).toContain(NOT_LISTED);
  });
});

describe.skipIf(NESTED)('OVR-12（変更なし）: 必須の項目がない・空の文字列なら、path と項目の名前を示して失敗する', () => {
  const path = 'src/assets/qa-missing-field.svg';
  for (const field of ['author', 'license', 'source'] as const) {
    it(`${field} がない`, () => {
      const item = oss(path, 'MIT');
      delete item[field];
      const result = checkWith([item]);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(path);
      expect(result.output).toContain(field);
    });

    it(`${field} が空の文字列`, () => {
      const result = checkWith([selfMade(path, { [field]: '' })]);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(path);
      expect(result.output).toContain(field);
    });
  }
});
