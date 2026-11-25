// docs/spec/screens.md「音」の UI-84 と UI-80（入力の記録の再生）の QA の受け入れテスト。
// 公開された入口（npm run build、npm run check:assets、RecordingInput・createPractice・practiceOutcome・replayRecording、
// 固定ステップのループ、武器とマップの JSON）だけを使う。
// UI-80 の画面での確認（リザルトのための計算し直し）は direction-sounds-qa.acceptance.test.ts にある。ここでは、
// 記録の再生で Web Audio の入口（AudioContext）が作られないことと、結果が一致することを確かめる。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FixedStepLoop } from '../../src/core/loop';
import { ManualTimeSource } from '../../src/core/time';
import { RecordingInput } from '../../src/input/recording';
import { parseMap } from '../../src/sim/map';
import { createPractice, practiceOutcome, replayRecording } from '../../src/sim/practice';
import { parseWeapon } from '../../src/sim/weapon';

const ROOT = resolve(__dirname, '../..');
const NESTED = process.env.APEX_ACCEPTANCE_NESTED === '1';
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'webm', 'mid', 'midi'];
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe.skipIf(NESTED)('UI-84: 配布物に音声のファイルがない', () => {
  it('npm run build のあと npm run check:assets が成功し、ビルド結果に音声のファイル（と音声の data: URL）が 1 つもない', () => {
    const out = mkdtempSync(join(tmpdir(), 'direction-sounds-dist-'));
    temps.push(out);
    const env = { ...process.env, FORCE_COLOR: '0', APEX_ACCEPTANCE_NESTED: '1' };
    const build = spawnSync(`npm run build -- --outDir "${out}" --emptyOutDir`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
    const check = spawnSync(`npm run --silent check:assets -- "${out}"`, { cwd: ROOT, shell: true, encoding: 'utf8', env });
    expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
    const files = walk(out);
    expect(files.length).toBeGreaterThan(0);
    const audio = files.filter((f) => AUDIO_EXT.includes(extname(f).slice(1).toLowerCase()));
    expect(audio.map((f) => relative(out, f))).toEqual([]);
    const inlined = files.filter((f) => /\.(js|css|html)$/.test(f) && /data:audio\//.test(readFileSync(f, 'utf8')));
    expect(inlined.map((f) => relative(out, f))).toEqual([]);
  }, 300_000);
});

describe('UI-80: 入力の記録の再生では音を鳴らさない', () => {
  it('同じ記録を再生すると練習と弾痕・採点が一致し、再生のあいだに AudioContext は作られない', () => {
    const mapRes = parseMap(JSON.parse(readFileSync(join(ROOT, 'src/data/maps/range.json'), 'utf8')));
    if (!mapRes.ok) throw new Error('range を読み込めない');
    const wRes = parseWeapon(JSON.parse(readFileSync(join(ROOT, 'src/data/weapons/lstar.json'), 'utf8')));
    if (!wRes.ok) throw new Error('lstar を読み込めない');
    const map = mapRes.map;
    const weapon = wRes.weapon;

    let created = 0;
    const g = globalThis as Record<string, unknown>;
    const saved = { AudioContext: g.AudioContext, webkitAudioContext: g.webkitAudioContext };
    g.AudioContext = class {
      constructor() {
        created += 1;
      }
    };
    g.webkitAudioContext = g.AudioContext;
    try {
      const input = new RecordingInput(12345);
      const practice = createPractice({ map, weapon, input, seed: input.seed });
      const time = new ManualTimeSource();
      const loop = new FixedStepLoop({ timeSource: time, update: () => practice.sim.step(), render: () => {} });
      let pushed = false;
      for (let f = 0; f < 60 * 4; f += 1) {
        time.advance(1 / 60);
        if (!pushed && time.now() >= 0.1) {
          input.push(loop.currentTime(), { type: 'fire', pressed: true });
          pushed = true;
        }
        loop.frame();
      }
      input.push(loop.currentTime(), { type: 'fire', pressed: false });
      loop.frame();
      const original = practiceOutcome(practice);
      expect(original.shots.length).toBe(weapon.magSize);

      const a = replayRecording(input.recording(), { map, weapon });
      const b = replayRecording(input.recording(), { map, weapon });
      expect(a.shots.map((s) => s.position)).toEqual(original.shots.map((s) => s.position));
      expect(a.score).toEqual(original.score);
      expect(b.shots.map((s) => s.position)).toEqual(a.shots.map((s) => s.position));
      expect(b.score).toEqual(a.score);
      expect(created).toBe(0);
    } finally {
      g.AudioContext = saved.AudioContext;
      g.webkitAudioContext = saved.webkitAudioContext;
    }
  });
});
