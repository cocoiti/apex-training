import { describe, expect, it, vi } from 'vitest';
import { SafeStorage } from '../../src/ui/storage';

/** Map で代用した Storage。failWrites が立っている間は書き込みが例外になる。 */
class FakeStorage implements Storage {
  readonly items = new Map<string, string>();
  failWrites = false;
  failReads = false;

  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException('denied', 'SecurityError');
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

describe('例外を投げない localStorage', () => {
  it('書き込めれば保存し、試しの書き込みは残さない', () => {
    const backing = new FakeStorage();
    const storage = new SafeStorage(() => backing);
    expect(storage.probe()).toBe(true);
    expect(backing.items.size).toBe(0);
    expect(storage.set('k', 'v')).toBe(true);
    expect(backing.items.get('k')).toBe('v');
    expect(new SafeStorage(() => backing).get('k')).toBe('v');
    expect(storage.unavailable).toBe(false);
  });

  it('起動時の試しの書き込みが例外になると、投げずに保存できないことを知らせる', () => {
    const backing = new FakeStorage();
    backing.failWrites = true;
    const storage = new SafeStorage(() => backing);
    const listener = vi.fn();
    storage.onUnavailable(listener);
    expect(storage.probe()).toBe(false);
    expect(storage.unavailable).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('localStorage の参照そのものが例外になっても投げない', () => {
    const storage = new SafeStorage(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(storage.probe()).toBe(false);
    expect(storage.get('k')).toBeNull();
    expect(storage.set('k', 'v')).toBe(false);
    expect(storage.get('k')).toBe('v');
  });

  it('起動後の保存で例外になったときも知らせ、一度だけ呼ぶ', () => {
    const backing = new FakeStorage();
    const storage = new SafeStorage(() => backing);
    const listener = vi.fn();
    storage.onUnavailable(listener);
    expect(storage.probe()).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    backing.failWrites = true;
    expect(storage.set('k', 'v')).toBe(false);
    expect(storage.set('k', 'w')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('保存できないと分かったあとは、書き込めるようになっても保存できない状態のまま', () => {
    const backing = new FakeStorage();
    backing.failWrites = true;
    const storage = new SafeStorage(() => backing);
    storage.probe();
    backing.failWrites = false;
    expect(storage.set('k', 'v')).toBe(true);
    expect(storage.unavailable).toBe(true);
  });

  it('保存できなくても、同じページの中では書いた値を読み返せる', () => {
    const backing = new FakeStorage();
    backing.failWrites = true;
    const storage = new SafeStorage(() => backing);
    storage.set('sensitivity', '3');
    expect(storage.get('sensitivity')).toBe('3');
    expect(storage.get('other')).toBeNull();
  });

  it('読み出しが例外になったら null を返す', () => {
    const backing = new FakeStorage();
    backing.failReads = true;
    expect(new SafeStorage(() => backing).get('k')).toBeNull();
  });

  it('すでに保存できないと分かっているときに登録すると、すぐに呼ぶ', () => {
    const storage = new SafeStorage(() => {
      throw new Error('no storage');
    });
    storage.probe();
    const listener = vi.fn();
    storage.onUnavailable(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
