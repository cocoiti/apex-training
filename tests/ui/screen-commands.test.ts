import { describe, expect, it } from 'vitest';
import type { ScreenControl } from '../../src/input/screen-controls';
import { screenCommand, type PlayPhase } from '../../src/ui/screen-commands';

const controls: ScreenControl[] = ['r', 'space', 'q', 'pad-a', 'pad-b', 'pad-y'];
const play = (phase: PlayPhase, inSet: boolean) => (control: ScreenControl) =>
  screenCommand({ screen: 'play', play: phase, inSet }, control);

describe('画面の操作（docs/spec/screens.md「画面の操作」）', () => {
  it('練習中は R と A / × でやり直す。連続練習なら Q と B / ○ でやめる', () => {
    expect(controls.map(play('practicing', true))).toEqual(['restart', undefined, 'quit', 'restart', 'quit', undefined]);
  });

  it('回数が 1 の練習中は、やめるの操作はない', () => {
    expect(controls.map(play('practicing', false))).toEqual(['restart', undefined, undefined, 'restart', undefined, undefined]);
  });

  it('短いリザルトの表示中は R・Space・A / × で次へ、Q・B / ○ でやめる', () => {
    expect(controls.map(play('interlude', true))).toEqual(['next', 'next', 'quit', 'next', 'quit', undefined]);
  });

  it('一時停止中と、練習が始まる前のプレイ画面では操作を受け付けない', () => {
    expect(controls.map(play('paused', true))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(controls.map(play('idle', false))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it.each(['result', 'set-result'] as const)('%s では R・Space・A / × がもう一度、B / ○ が武器変更、Y / △ が結果をシェア（Q は割り当てない）', (screen) => {
    expect(controls.map((c) => screenCommand({ screen, play: 'idle', inSet: false }, c))).toEqual([
      'again',
      'again',
      undefined,
      'again',
      'change-weapon',
      'share',
    ]);
  });

  it.each(['top', 'settings', 'settings-pad'] as const)('%s では何もしない', (screen) => {
    expect(controls.map((c) => screenCommand({ screen, play: 'idle', inSet: false }, c)).every((c) => c === undefined)).toBe(true);
  });
});
