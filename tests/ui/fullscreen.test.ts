import { describe, expect, it } from 'vitest';
import { fullscreenLabel, toggleFullscreen, type FullscreenDocument } from '../../src/ui/fullscreen';

/** 全画面の状態を持つだけの document と要素。 */
function fakes(options: { reject?: boolean } = {}) {
  const target = {} as Element;
  const doc: FullscreenDocument & { fullscreenElement: Element | null } = {
    fullscreenElement: null,
    exitFullscreen: () => {
      doc.fullscreenElement = null;
      return Promise.resolve();
    },
  };
  const element = {
    requestFullscreen: () => {
      if (options.reject) return Promise.reject(new TypeError('拒否'));
      doc.fullscreenElement = target;
      return Promise.resolve();
    },
  };
  return { doc, element };
}

describe('全画面の切替', () => {
  it('MOU-9: 押すと全画面になり、もう一度押すと解除される', async () => {
    const { doc, element } = fakes();
    expect(fullscreenLabel(doc)).toBe('全画面');
    await toggleFullscreen(doc, element);
    expect(doc.fullscreenElement).not.toBeNull();
    expect(fullscreenLabel(doc)).toBe('全画面を解除');
    await toggleFullscreen(doc, element);
    expect(doc.fullscreenElement).toBeNull();
    expect(fullscreenLabel(doc)).toBe('全画面');
  });

  it('全画面を拒否されても例外にしない', async () => {
    const { doc, element } = fakes({ reject: true });
    await expect(toggleFullscreen(doc, element)).resolves.toBeUndefined();
    expect(doc.fullscreenElement).toBeNull();
  });
});
