import { describe, expect, it } from 'vitest';
import { SCREEN_HASHES, screenFromHash, watchScreen, type HashSource, type ScreenId } from '../../src/ui/router';

describe('ハッシュから画面を引く', () => {
  it.each(Object.entries(SCREEN_HASHES) as [ScreenId, string][])('%s のハッシュ %s はその画面になる', (screen, hash) => {
    expect(screenFromHash(hash)).toBe(screen);
  });

  it('末尾のスラッシュは無視する', () => {
    expect(screenFromHash('#/settings/')).toBe('settings');
    expect(screenFromHash('#/settings/pad/')).toBe('settings-pad');
  });

  it.each(['', '#', '#/unknown', '#settings', '#/settings/unknown', '#/SETTINGS'])(
    'どの画面にも当たらないハッシュ "%s" はトップ画面になる（OVR-6）',
    (hash) => {
      expect(screenFromHash(hash)).toBe('top');
    },
  );
});

/** DOM のない環境で、window を EventTarget で代用する。 */
class FakeWindow extends EventTarget implements HashSource {
  location = { hash: '' };

  go(hash: string): void {
    this.location.hash = hash;
    this.dispatchEvent(new Event('hashchange'));
  }
}

describe('画面の切替の監視', () => {
  it('今のハッシュの画面ですぐに呼び、ハッシュが変わるたびに呼ぶ', () => {
    const win = new FakeWindow();
    win.location.hash = '#/settings';
    const screens: ScreenId[] = [];
    const stop = watchScreen(win, (screen) => screens.push(screen));
    expect(screens).toEqual(['settings']);

    win.go('#/play');
    win.go('#/unknown');
    expect(screens).toEqual(['settings', 'play', 'top']);

    stop();
    win.go('#/result');
    expect(screens).toEqual(['settings', 'play', 'top']);
  });
});
