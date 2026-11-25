// ビルドの結果を gh-pages ブランチのルートに置いて push し、GitHub Pages で公開する（docs/spec/overview.md「公開」、OVR-7）。
// GitHub Actions を止めているため手動で実行する（npm run deploy）。
// 作業は一時的な作業ツリー（git worktree）で行い、実行したときの作業ツリー・今のブランチ・既定ブランチには触れない。
// ローカルのブランチも作らず、作ったコミットを <remote> の gh-pages へ直接 push する。
// ビルドの出力先も作業ツリーの外の一時ディレクトリにし、作業ツリーの dist/ を作ったり上書きしたりしない。
// 公開したものがコミットと一致するよう、未コミットの変更（無視されたファイルを除く）があれば公開しない。
// 環境変数 DEPLOY_REMOTE（既定 origin）と DEPLOY_BUILD_COMMAND（既定 npm run build に出力先を渡したもの）は、テストで差し替えるためのもの。
// 差し替えたビルドのコマンドは、環境変数 DEPLOY_OUT_DIR の場所にビルドの結果を出す。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRANCH = 'gh-pages';
const REMOTE = process.env.DEPLOY_REMOTE || 'origin';

class DeployError extends Error {}

/** git を実行し、標準出力を返す。失敗したら DeployError を投げる。 */
function git(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFailure) {
    throw new DeployError(`git ${args.join(' ')} が失敗した:\n${result.stderr ?? ''}`);
  }
  return { status: result.status, stdout: (result.stdout ?? '').trim() };
}

function deploy() {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).stdout;

  // ビルドは作業ツリーで行うため、未コミットの変更があると、どのコミットとも一致しないものを公開してしまう。
  const dirty = git(['status', '--porcelain', '--untracked-files=all'], root).stdout;
  if (dirty) {
    throw new DeployError(
      `作業ツリーに未コミットの変更がある。コミットするか片付けてから公開する。公開しない。\n${dirty}`,
    );
  }

  const temp = mkdtempSync(join(tmpdir(), 'apex-deploy-'));
  const dist = join(temp, 'dist');
  const site = join(temp, 'site');
  let added = false;
  try {
    const command = process.env.DEPLOY_BUILD_COMMAND || `npm run build -- --outDir "${dist}" --emptyOutDir`;
    console.log(`ビルドする: ${command}`);
    const build = spawnSync(command, { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, DEPLOY_OUT_DIR: dist } });
    if (build.status !== 0) throw new DeployError('ビルドが失敗した。公開しない。');
    if (!existsSync(join(dist, 'index.html'))) throw new DeployError('ビルドの結果（dist/index.html）がない。公開しない。');

    // 前回の公開があれば、その上にコミットを積む（push を早送りにする）。
    const remoteHead = git(['ls-remote', '--heads', REMOTE, `refs/heads/${BRANCH}`], root).stdout.split(/\s+/)[0] || '';
    if (remoteHead) git(['fetch', '--quiet', REMOTE, `refs/heads/${BRANCH}`], root);

    // チェックアウトせずに作るので、作業ツリーは空。ここにビルドの結果だけを置いて、そのままツリーにする。
    git(['worktree', 'add', '--quiet', '--detach', '--no-checkout', site, remoteHead || 'HEAD'], root);
    added = true;
    for (const name of readdirSync(site)) if (name !== '.git') rmSync(join(site, name), { recursive: true, force: true });
    cpSync(dist, site, { recursive: true });
    writeFileSync(join(site, '.nojekyll'), '');
    git(['add', '--all', '--force', '.'], site); // ignore の設定に左右されず、ビルドの結果をすべて入れる。
    const tree = git(['write-tree'], site).stdout;

    if (remoteHead && git(['rev-parse', `${remoteHead}^{tree}`], site).stdout === tree) {
      console.log(`${BRANCH} の内容は今回のビルドと同じ。push しない。`);
      return;
    }
    const source = git(['rev-parse', '--short', 'HEAD'], root).stdout;
    const parent = remoteHead ? ['-p', remoteHead] : [];
    const commit = git(['commit-tree', tree, ...parent, '-m', `deploy: ${source} のビルド結果を公開する`], site).stdout;

    const push = spawnSync('git', ['push', REMOTE, `${commit}:refs/heads/${BRANCH}`], { cwd: root, stdio: 'inherit' });
    if (push.status !== 0) throw new DeployError(`${REMOTE} の ${BRANCH} への push が失敗した。`);
    console.log(`${REMOTE} の ${BRANCH} に公開した（${commit.slice(0, 7)}）。`);
  } finally {
    if (added) git(['worktree', 'remove', '--force', site], root, { allowFailure: true });
    rmSync(temp, { recursive: true, force: true });
    git(['worktree', 'prune'], root, { allowFailure: true });
  }
}

try {
  deploy();
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
