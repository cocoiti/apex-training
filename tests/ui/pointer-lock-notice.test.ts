import { describe, expect, it } from 'vitest';
import { t } from '../../src/ui/i18n';
import {
  showPaused,
  showPointerLockNotice,
} from '../../src/ui/pointer-lock-notice';

const notice = () => ({ hidden: true, textContent: '', dataset: {} as DOMStringMap });

describe('ポインターロックの表示', () => {
  it('MOU-2: 通常のポインターロックになったときはマウス加速の警告を出す', () => {
    const element = notice();
    showPointerLockNotice(element, 'accelerated');
    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe(t('play.mouseAcceleration'));
    expect(element.textContent).toContain('マウス加速');
    expect(element.dataset.kind).toBe('warning');
  });

  it('MOU-7: ポインターロックが失敗したときはその旨を出す', () => {
    const element = notice();
    showPointerLockNotice(element, 'failed');
    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe(t('play.pointerLockFailed'));
    expect(element.textContent).toContain('ポインターロックできませんでした');
    expect(element.dataset.kind).toBe('error');
  });

  it('MOU-1: 加速を外したポインターロックになったときは出さず、前の表示も消す', () => {
    const element = notice();
    showPointerLockNotice(element, 'failed');
    showPointerLockNotice(element, 'raw');
    expect(element.hidden).toBe(true);
    expect(element.textContent).toBe('');
    expect(element.dataset.kind).toBeUndefined();
  });

  it('一時停止の表示を出して消す', () => {
    const element = { hidden: true, textContent: '' };
    showPaused(element, true);
    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe(t('play.paused'));
    showPaused(element, false);
    expect(element.hidden).toBe(true);
  });
});
