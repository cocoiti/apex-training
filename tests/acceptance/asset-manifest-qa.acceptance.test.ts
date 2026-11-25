// docs/spec/overview.md「素材の一覧」の受け入れ条件（OVR-2・OVR-10・OVR-12〜OVR-14。OVR-11 は削除して欠番）の QA の受け入れテスト。
// 公開された入口（npm run check:assets、npm run build、素材の一覧 src/assets/assets.json）だけを使い、
// 期待値は SPEC の文から求める。リポジトリを書き換えないよう、一時ディレクトリの写しで実行する。
// ARC-13 の clone の中で npm test を実行したときに入れ子で重い確認をしないよう、APEX_ACCEPTANCE_NESTED が立っていたら飛ばす。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const MANIFEST = 'src/assets/assets.json';

interface Entry {
  path?: unknown;
  author?: unknown;
  license?: unknown;
  source?: unknown;
}

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

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** 1x1 の小さな PNG（Vite の既定なら data: URL に埋め込まれる大きさ）。 */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

function entry(path: string, extra: Partial<Record<keyof Entry, unknown>> = {}): Entry {
  return { path, author: '自作', license: 'self-made', source: 'QA の受け入れテストで作った 1 画素の画像', ...extra };
}

/**
 * 検査のコマンドを実行するためのリポジトリの写しを作る（package.json・scripts/・src/ と、ビルドの結果の dist/）。
 * files はリポジトリのルートからのパスと中身、manifest は素材の一覧の中身。
 */
function repoCopy(options: { manifest: unknown; files?: Record<string, string | Buffer>; distFiles?: Record<string, string | Buffer> }) {
  const repo = temp('ovr-qa-repo-');
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

const check = (repo: string) => run('npm run --silent check:assets', repo);

beforeAll(() => {
  if (NESTED) return;
  const out = temp('ovr-qa-dist-');
  const build = run(`npm run build -- --outDir "${out}" --emptyOutDir`, ROOT);
  if (build.status !== 0) throw new Error(`ビルドが失敗した:\n${build.output}`);
  dist = out;
}, 300_000);

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(NESTED)('OVR-2: 一覧に載った画像だけ（または素材なし）なら検査が成功する', () => {
  it('素材が 1 つもなく一覧が空の配列なら成功する', () => {
    const result = check(repoCopy({ manifest: [] }));
    expect(result.status, result.output).toBe(0);
  });

  it('src/ の下の素材: 一覧に載った画像がハッシュ付きの名前でビルドの結果にあるとき成功する', () => {
    const repo = repoCopy({
      manifest: [entry('src/assets/qa-icon.png')],
      files: { 'src/assets/qa-icon.png': tinyPng() },
      distFiles: { 'assets/qa-icon-BxQ_3kLm.png': tinyPng() },
    });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it('public/ の下の素材: 一覧の path から public/ を除いたパスでビルドの結果にあるとき成功する', () => {
    const repo = repoCopy({
      manifest: [entry('public/qa-favicon.svg')],
      files: { 'public/qa-favicon.svg': SVG },
      distFiles: { 'qa-favicon.svg': SVG },
    });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });

  it('src/ と public/ の素材が混ざっていても、すべて一覧に載っていれば成功する', () => {
    const repo = repoCopy({
      manifest: [entry('src/assets/icons/play.svg'), entry('public/qa-favicon.svg')],
      files: { 'src/assets/icons/play.svg': SVG, 'public/qa-favicon.svg': SVG },
      distFiles: { 'assets/play-D4f9aZ1q.svg': SVG, 'qa-favicon.svg': SVG },
    });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-10: 一覧に載っていない画像がビルドの結果にあると失敗する', () => {
  const NOT_LISTED = '一覧に載っていない';

  it('一覧が空で dist/assets/unknown.png を置くと、そのパスと「一覧に載っていない」旨を示して失敗する', () => {
    const repo = repoCopy({ manifest: [], distFiles: { 'assets/unknown.png': tinyPng() } });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(['assets', 'unknown.png'].join(sep));
    expect(result.output).toContain(NOT_LISTED);
  });

  it('ほかの画像が一覧に載っていても、載っていない画像だけを示して失敗する', () => {
    const repo = repoCopy({
      manifest: [entry('src/assets/qa-icon.png')],
      files: { 'src/assets/qa-icon.png': tinyPng() },
      distFiles: { 'assets/qa-icon-BxQ_3kLm.png': tinyPng(), 'assets/unknown.png': tinyPng() },
    });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('unknown.png');
    expect(result.output).toContain(NOT_LISTED);
    expect(result.output).not.toContain('qa-icon-BxQ_3kLm.png');
  });

  it('public/ の素材として載った名前でも、ビルドの結果の別の場所にあれば一覧に載っていないとみなす', () => {
    const repo = repoCopy({
      manifest: [entry('public/qa-favicon.svg')],
      files: { 'public/qa-favicon.svg': SVG },
      distFiles: { 'qa-favicon.svg': SVG, 'other/qa-favicon.svg': SVG },
    });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(['other', 'qa-favicon.svg'].join(sep));
    expect(result.output).toContain(NOT_LISTED);
  });

  it('拡張子が違えば一覧の名前と同じでも載っていないとみなす（大文字の拡張子も対象）', () => {
    const repo = repoCopy({
      manifest: [entry('src/assets/qa-icon.png')],
      files: { 'src/assets/qa-icon.png': tinyPng() },
      distFiles: { 'assets/qa-icon-BxQ_3kLm.JPG': 'x' },
    });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('qa-icon-BxQ_3kLm.JPG');
    expect(result.output).toContain(NOT_LISTED);
  });
});

describe.skipIf(NESTED)('OVR-12: 必須の項目がない、または空の文字列の素材があると失敗する', () => {
  const path = 'src/assets/qa-icon.png';
  for (const field of ['author', 'license', 'source'] as const) {
    it(`${field} がないとき、その素材の path と ${field} を示して失敗する`, () => {
      const item = entry(path);
      delete item[field];
      const repo = repoCopy({ manifest: [item], files: { [path]: tinyPng() } });
      const result = check(repo);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(path);
      expect(result.output).toContain(field);
    });

    it(`${field} が空の文字列のとき、その素材の path と ${field} を示して失敗する`, () => {
      const repo = repoCopy({ manifest: [entry(path, { [field]: '' })], files: { [path]: tinyPng() } });
      const result = check(repo);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(path);
      expect(result.output).toContain(field);
    });
  }

  it('license と source が両方欠けていれば、両方の名前を示す', () => {
    const item = entry(path, { source: '' });
    delete item.license;
    const repo = repoCopy({ manifest: [item], files: { [path]: tinyPng() } });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(path);
    expect(result.output).toContain('license');
    expect(result.output).toContain('source');
  });

  it('path が空の文字列の項目があるときも失敗し、path の欠けを示す', () => {
    const repo = repoCopy({ manifest: [entry('')] });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain('path');
  });
});

describe.skipIf(NESTED)('OVR-13: 一覧の path がリポジトリにないファイルを指すと失敗する', () => {
  it('その path とファイルがない旨を示して失敗する', () => {
    const path = 'src/assets/qa-missing.png';
    const repo = repoCopy({ manifest: [entry(path)] });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(path);
    expect(result.output).toMatch(/ない|存在しない|見つから/);
  });

  it('public/ の path でも同じく失敗する', () => {
    const path = 'public/qa-missing.svg';
    const repo = repoCopy({ manifest: [entry(path)] });
    const result = check(repo);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(path);
  });

  it('対照: 同じ path のファイルを置けば成功する', () => {
    const path = 'src/assets/qa-missing.png';
    const repo = repoCopy({ manifest: [entry(path)], files: { [path]: tinyPng() } });
    const result = check(repo);
    expect(result.status, result.output).toBe(0);
  });
});

describe.skipIf(NESTED)('OVR-14: 一覧に載った画像を src/ から読み込んでビルドすると、ファイルとして出て検査が成功する', () => {
  let repo = '';
  let out = '';
  let build: { status: number | null; output: string } = { status: null, output: '' };
  const png = tinyPng();

  beforeAll(() => {
    // ビルドに要るものを写し、小さな画像（Vite の既定なら data: URL になる大きさ）をエントリから import する。
    repo = temp('ovr14-repo-');
    for (const name of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'src', 'scripts', 'tests']) {
      cpSync(join(ROOT, name), join(repo, name), { recursive: true });
    }
    symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    writeFileSync(join(repo, 'src/assets/qa-mark.png'), png);
    writeFileSync(join(repo, MANIFEST), JSON.stringify([entry('src/assets/qa-mark.png')], null, 2));
    const html = readFileSync(join(repo, 'index.html'), 'utf8');
    const main = /<script[^>]*type="module"[^>]*src="\/([^"]+)"/.exec(html)?.[1];
    if (!main) throw new Error('index.html にエントリの script がない');
    const mainPath = join(repo, main);
    writeFileSync(
      mainPath,
      `${readFileSync(mainPath, 'utf8')}\nimport qaMarkUrl from './assets/qa-mark.png';\n(globalThis as { __qaMark?: string }).__qaMark = qaMarkUrl;\n`,
    );
    out = join(repo, 'dist');
    build = run('npm run build', repo);
  }, 300_000);

  it('ビルドが成功する', () => {
    expect(build.status, build.output).toBe(0);
  });

  it('画像はハッシュ付きのファイルとしてビルドの結果に出る', () => {
    const images = filesUnder(out)
      .map((f) => relative(out, f).split(sep).join('/'))
      .filter((f) => /qa-mark.*\.png$/.test(f));
    expect(images, filesUnder(out).join('\n')).toHaveLength(1);
    expect(readFileSync(join(out, images[0]!)).equals(png)).toBe(true);
  });

  it('JS と CSS に画像の data: URL が埋め込まれていない', () => {
    const code = filesUnder(out).filter((f) => /\.(js|css|html)$/.test(f));
    for (const file of code) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/data:image\//);
    }
    const js = code.filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(js).toMatch(/qa-mark[^"'`]*\.png/);
  });

  it('検査のコマンドが成功する', () => {
    const result = run('npm run --silent check:assets', repo);
    expect(result.status, result.output).toBe(0);
  });
});
