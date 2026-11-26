// npm run test:remote（scripts/test-remote.mjs、docs/spec/architecture.md「Docker でのブラウザのテスト」、ARC-69〜ARC-71）の確認。
// docker は TEST_DOCKER_COMMAND で、受けた引数を記録する偽物に差し替える。本物の Docker でイメージを作って流すことは手で確かめる。
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/test-remote.mjs');
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * docker に見立てたスクリプト。受けた引数と APEX_BROWSER_WORKERS を FAKE_LOG に 1 行ずつ JSON で書く。
 * FAKE_CONTEXTS（, 区切り）にない context は inspect で失敗し、FAKE_UNREACHABLE の context は info で失敗する。
 * build は FAKE_BUILD_FAIL が 1 なら失敗し、そうでなければ --iidfile に ID を書く。run は FAKE_RUN_STATUS で終わる。
 */
const FAKE_DOCKER = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, workers: process.env.APEX_BROWSER_WORKERS ?? null }) + '\\n');
const rest = args[0] === '--context' ? args.slice(2) : args;
const context = args[0] === '--context' ? args[1] : undefined;
const contexts = (process.env.FAKE_CONTEXTS ?? '').split(',').filter(Boolean);
if (rest[0] === 'context' && rest[1] === 'inspect') process.exit(contexts.includes(rest[2]) ? 0 : 1);
if (rest[0] === 'info') process.exit(context === process.env.FAKE_UNREACHABLE ? 1 : 0);
if (rest[0] === 'build') {
  if (process.env.FAKE_BUILD_FAIL === '1') process.exit(4);
  writeFileSync(rest[rest.indexOf('--iidfile') + 1], 'sha256:fakeimage\\n');
  process.exit(0);
}
if (rest[0] === 'run') process.exit(Number(process.env.FAKE_RUN_STATUS ?? '0'));
process.exit(9);
`;

let fake = '';
let log = '';

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'test-remote-'));
  temps.push(dir);
  fake = join(dir, 'docker');
  writeFileSync(fake, FAKE_DOCKER);
  chmodSync(fake, 0o755);
  log = join(dir, 'calls.log');
});

function testRemote(env: Record<string, string | undefined> = {}) {
  rmSync(log, { force: true });
  const base: Record<string, string | undefined> = { ...process.env, TEST_DOCKER_CONTEXT: undefined, APEX_BROWSER_WORKERS: undefined };
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...base, TEST_DOCKER_COMMAND: fake, FAKE_LOG: log, ...env } as NodeJS.ProcessEnv,
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; workers: string | null })
    : [];
  const find = (command: string) => calls.find((c) => (c.args[0] === '--context' ? c.args[2] : c.args[0]) === command);
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls, build: find('build'), run: find('run') };
}

describe('npm run test:remote', () => {
  it('package.json の test:remote が scripts/test-remote.mjs を動かす', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:remote']).toBe('node scripts/test-remote.mjs');
  });

  it('既定の context は macmini で、あってつながればその context でイメージを作り、コンテナの中で npm run test:browser を流す', () => {
    const r = testRemote({ FAKE_CONTEXTS: 'macmini' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('docker context「macmini」の Docker で流す');
    expect(r.build?.args.slice(0, 3)).toEqual(['--context', 'macmini', 'build']);
    expect(r.build?.args).toContain(join(ROOT, 'Dockerfile.test'));
    expect(r.build?.args.at(-1)).toBe(ROOT);
    expect(r.run?.args.slice(0, 3)).toEqual(['--context', 'macmini', 'run']);
    // 作ったイメージは、並行に流す別の作業ツリーと取り違えないよう ID で動かす。
    expect(r.run?.args.slice(-4)).toEqual(['sha256:fakeimage', 'npm', 'run', 'test:browser']);
    expect(r.run?.args).toContain('--rm');
  });

  it('TEST_DOCKER_CONTEXT で context の名前を変えられる', () => {
    const r = testRemote({ TEST_DOCKER_CONTEXT: 'other', FAKE_CONTEXTS: 'macmini,other' });
    expect(r.status, r.output).toBe(0);
    expect(r.build?.args.slice(0, 2)).toEqual(['--context', 'other']);
    expect(r.run?.args.slice(0, 2)).toEqual(['--context', 'other']);
  });

  it('ARC-69: その名前の context がないときは、手元の Docker（今の context）で作って流し、そのことを出力に示す', () => {
    const r = testRemote({ TEST_DOCKER_CONTEXT: 'no-such-context', FAKE_CONTEXTS: 'macmini' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/「no-such-context」がない。手元の Docker で流す/);
    expect(r.build?.args[0]).toBe('build');
    expect(r.run?.args[0]).toBe('run');
  });

  it('context はあってもその Docker につながらないときは、手元の Docker で流す', () => {
    const r = testRemote({ FAKE_CONTEXTS: 'macmini', FAKE_UNREACHABLE: 'macmini' });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/「macmini」の Docker につながらない。手元の Docker で流す/);
    expect(r.build?.args[0]).toBe('build');
    expect(r.run?.args[0]).toBe('run');
  });

  it('ARC-70: コンテナの中のテストの終了コードをそのまま返す', () => {
    const r = testRemote({ FAKE_CONTEXTS: '', FAKE_RUN_STATUS: '3' });
    expect(r.status).toBe(3);
    expect(r.output).toContain('終了コード: 3');
  });

  it('イメージを作るのに失敗したら、テストを流さず 0 以外で終わる', () => {
    const r = testRemote({ FAKE_BUILD_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.run).toBeUndefined();
    expect(r.output).toContain('イメージを作るのに失敗した');
  });

  it('docker が見つからなければ、Docker が要ることを示して 0 以外で終わる', () => {
    const r = testRemote({ TEST_DOCKER_COMMAND: join(tmpdir(), 'no-such-docker-command') });
    expect(r.status).not.toBe(0);
    expect(r.output).toContain('Docker が要る');
  });

  it('APEX_BROWSER_WORKERS があればその値を、なければ 2 をコンテナの中に渡す', () => {
    const passed = testRemote({ APEX_BROWSER_WORKERS: '1' });
    expect(passed.status, passed.output).toBe(0);
    expect(passed.run?.args.join(' ')).toContain('-e APEX_BROWSER_WORKERS=1');
    const omitted = testRemote();
    expect(omitted.status, omitted.output).toBe(0);
    expect(omitted.run?.args.join(' ')).toContain('-e APEX_BROWSER_WORKERS=2');
  });
});
