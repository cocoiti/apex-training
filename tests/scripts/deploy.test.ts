import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../scripts/deploy.mjs');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** ビルドに見立てたスクリプト。FAKE_DIST に書いたパスの空でないファイルを DEPLOY_OUT_DIR に作り直す。FAKE_FAIL が立っていたら失敗する。 */
const FAKE_BUILD = `
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
if (process.env.FAKE_FAIL === '1') process.exit(2);
const out = process.env.DEPLOY_OUT_DIR;
rmSync(out, { recursive: true, force: true });
for (const file of JSON.parse(process.env.FAKE_DIST)) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), 'content of ' + file);
}
`;

let remote = '';
let repo = '';
let build = '';

/** origin に見立てた bare リポジトリと、main とブランチ feat/x を持ち、未コミットの変更がある clone を作る。 */
beforeEach(() => {
  remote = join(tempDir('deploy-remote-'), 'origin.git');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], tmpdir());
  repo = join(tempDir('deploy-repo-'), 'repo');
  git(['clone', '--quiet', remote, repo], tmpdir());
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  writeFileSync(join(repo, 'source.txt'), 'main\n');
  git(['add', '.'], repo);
  git(['commit', '--quiet', '-m', 'init'], repo);
  git(['push', '--quiet', 'origin', 'main'], repo);
  git(['checkout', '--quiet', '-b', 'feat/x'], repo);
  writeFileSync(join(repo, 'source.txt'), 'feat\n');
  git(['commit', '--quiet', '-am', 'feat'], repo);
  writeFileSync(join(repo, 'source.txt'), 'uncommitted\n');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
  build = join(tempDir('deploy-build-'), 'build.mjs');
  writeFileSync(build, FAKE_BUILD);
});

function deploy(files: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...ENV, DEPLOY_BUILD_COMMAND: `"${process.execPath}" "${build}"`, FAKE_DIST: JSON.stringify(files), ...extra },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** origin の gh-pages のファイルの一覧。ブランチがなければ null。 */
function publishedFiles(): string[] | null {
  const ref = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/gh-pages'], { cwd: remote, encoding: 'utf8' });
  if (ref.status !== 0) return null;
  return git(['ls-tree', '-r', '--name-only', 'gh-pages'], remote).split('\n').sort();
}

/** 実行の前後で変わってはいけないものをまとめる。 */
function localState() {
  return {
    head: git(['symbolic-ref', 'HEAD'], repo),
    feat: git(['rev-parse', 'feat/x'], repo),
    main: git(['rev-parse', 'main'], repo),
    originMain: git(['rev-parse', 'main'], remote),
    status: git(['status', '--porcelain'], repo),
    source: readFileSync(join(repo, 'source.txt'), 'utf8'),
    branches: git(['branch', '--list'], repo),
    worktrees: git(['worktree', 'list', '--porcelain'], repo),
    dist: existsSync(join(repo, 'dist')) ? readdirSync(join(repo, 'dist'), { recursive: true }).map(String).sort() : null,
    stale: existsSync(join(repo, 'dist', 'stale.html')) ? readFileSync(join(repo, 'dist', 'stale.html'), 'utf8') : null,
  };
}

describe('公開のコマンド（OVR-7）', () => {
  it('初めての公開で、gh-pages のルートにビルドの結果と .nojekyll だけを置き、手元の状態を変えない', () => {
    const before = localState();
    const result = deploy(['index.html', 'assets/index.js', 'assets/range.json']);
    expect(result.status, result.output).toBe(0);
    expect(publishedFiles()).toEqual(['.nojekyll', 'assets/index.js', 'assets/range.json', 'index.html']);
    expect(git(['show', 'gh-pages:index.html'], remote)).toBe('content of index.html');
    expect(git(['show', 'gh-pages:.nojekyll'], remote)).toBe('');
    expect(localState()).toEqual(before);
  });

  it('2 回目の公開で、前回にあって今回のビルドにないファイルを消し、前回のコミットの上に積む', () => {
    expect(deploy(['index.html', 'assets/old.js']).status).toBe(0);
    const first = git(['rev-parse', 'gh-pages'], remote);
    const before = localState();
    const result = deploy(['index.html', 'assets/new.js']);
    expect(result.status, result.output).toBe(0);
    expect(publishedFiles()).toEqual(['.nojekyll', 'assets/new.js', 'index.html']);
    expect(git(['rev-parse', 'gh-pages^'], remote)).toBe(first);
    expect(localState()).toEqual(before);
  });

  it('ビルドの結果が前回と同じなら push しない', () => {
    expect(deploy(['index.html']).status).toBe(0);
    const first = git(['rev-parse', 'gh-pages'], remote);
    const result = deploy(['index.html']);
    expect(result.status, result.output).toBe(0);
    expect(git(['rev-parse', 'gh-pages'], remote)).toBe(first);
  });

  it('作業ツリーの dist/ を作らず、あっても上書きしない（ビルドは作業ツリーの外に出す）', () => {
    expect(deploy(['index.html']).status).toBe(0);
    expect(existsSync(join(repo, 'dist'))).toBe(false);
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'stale.html'), 'local');
    const before = localState();
    const result = deploy(['index.html', 'assets/new.js']);
    expect(result.status, result.output).toBe(0);
    expect(localState()).toEqual(before);
    expect(publishedFiles()).toEqual(['.nojekyll', 'assets/new.js', 'index.html']);
  });

  it('ビルドが失敗したら、その旨を示して 0 以外で終わり、gh-pages を作らない', () => {
    const before = localState();
    const result = deploy(['index.html'], { FAKE_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('ビルドが失敗した');
    expect(publishedFiles()).toBeNull();
    expect(localState()).toEqual(before);
  });

  it('ビルドの結果に index.html がなければ公開しない', () => {
    const result = deploy(['assets/index.js']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('dist/index.html');
    expect(publishedFiles()).toBeNull();
  });

  it('push が失敗したら、その旨を示して 0 以外で終わり、gh-pages を変えず、一時的な作業ツリーを片付ける', () => {
    expect(deploy(['index.html']).status).toBe(0);
    const first = git(['rev-parse', 'gh-pages'], remote);
    const hook = join(remote, 'hooks', 'pre-receive');
    mkdirSync(join(remote, 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = localState();
    const result = deploy(['index.html', 'assets/new.js']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('push が失敗した');
    expect(git(['rev-parse', 'gh-pages'], remote)).toBe(first);
    expect(localState()).toEqual(before);
  });
});
