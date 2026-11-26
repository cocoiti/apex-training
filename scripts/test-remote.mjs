// ブラウザを使うテストを Docker のコンテナの中で流す（docs/spec/architecture.md「Docker でのブラウザのテスト」、ARC-69〜ARC-71）。
// npm run test:remote で実行する。Dockerfile.test でイメージを作り、コンテナの中で npm run test:browser を流す。
// 環境変数 TEST_DOCKER_CONTEXT（既定 macmini）の docker context があってその Docker につながるときはその context で、
// ないかつながらないときは手元の Docker（今の docker context）で流す。どちらで流すかはテストを流す前に出す。
// 終了コードは、コンテナの中の npm run test:browser の終了コード。イメージを作れなかったときも 0 以外。
// コンテナの中で同時に流すブラウザを使うテストのファイルの数は APEX_BROWSER_WORKERS で、手元になければ 2 にする
// （Mac mini で 3 つずつ流すと、実時間で動くテストが待ちの上限に当たる）。
// 環境変数 TEST_DOCKER_COMMAND（既定 docker）は、テストで docker を差し替えるためのもの。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKER = process.env.TEST_DOCKER_COMMAND || 'docker';
const DEFAULT_CONTEXT = 'macmini';
const IMAGE = 'apex-training-test';
/** コンテナの中で同時に流すブラウザを使うテストのファイルの数の既定。手元の APEX_BROWSER_WORKERS があればそちらを渡す。 */
const DEFAULT_WORKERS = '2';
/** context の Docker につながるかを確かめるときに待つ上限。つながらない context で長く止まらないようにする。 */
const PROBE_TIMEOUT_MS = 15_000;

class RemoteTestError extends Error {}

function docker(args, options = {}) {
  const result = spawnSync(DOCKER, args, { encoding: 'utf8', ...options });
  if (result.error && result.error.code === 'ENOENT') {
    throw new RemoteTestError(`${DOCKER} が見つからない。npm run test:remote には Docker が要る。`);
  }
  return result;
}

/** 使う context の名前。その context がないかつながらないときは undefined（手元の Docker で流す）。 */
function chooseContext(name) {
  const inspect = docker(['context', 'inspect', name], { stdio: 'pipe' });
  if (inspect.status !== 0) {
    console.log(`docker context「${name}」がない。手元の Docker で流す。`);
    return undefined;
  }
  const info = docker(['--context', name, 'info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS });
  if (info.status !== 0) {
    console.log(`docker context「${name}」の Docker につながらない。手元の Docker で流す。`);
    return undefined;
  }
  console.log(`docker context「${name}」の Docker で流す。`);
  return name;
}

function testRemote() {
  const name = process.env.TEST_DOCKER_CONTEXT?.trim() || DEFAULT_CONTEXT;
  const context = chooseContext(name);
  const prefix = context ? ['--context', context] : [];

  const temp = mkdtempSync(join(tmpdir(), 'apex-test-remote-'));
  try {
    // 並行に流す別の作業ツリーがタグを上書きしても取り違えないよう、作ったイメージは ID で動かす。
    const iidfile = join(temp, 'image-id');
    const build = docker([...prefix, 'build', '-f', join(ROOT, 'Dockerfile.test'), '-t', IMAGE, '--iidfile', iidfile, ROOT], { stdio: 'inherit' });
    if (build.status !== 0) throw new RemoteTestError('イメージを作るのに失敗した。テストは流していない。');
    const image = readFileSync(iidfile, 'utf8').trim();
    if (!image) throw new RemoteTestError('作ったイメージの ID が読めない。テストは流していない。');

    const workers = process.env.APEX_BROWSER_WORKERS ?? DEFAULT_WORKERS;
    const env = ['-e', `APEX_BROWSER_WORKERS=${workers}`];
    // Chromium は共有メモリを多く使うので、コンテナの /dev/shm の小ささに当たらないよう ipc を host にする。
    const run = docker([...prefix, 'run', '--rm', '--init', '--ipc=host', ...env, image, 'npm', 'run', 'test:browser'], { stdio: 'inherit' });
    const status = run.status ?? 1;
    console.log(`コンテナの中の npm run test:browser の終了コード: ${status}（${context ? `docker context「${context}」` : '手元の Docker'}）`);
    return status;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = testRemote();
} catch (error) {
  if (!(error instanceof RemoteTestError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
