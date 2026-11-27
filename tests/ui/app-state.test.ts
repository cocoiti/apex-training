import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_STATE_ATTRIBUTE, AppStateMark } from '../../src/ui/app-state';

/** 属性だけを持つ <html> の代わり。 */
function fakeRoot() {
  const attributes = new Map<string, string>();
  return { attributes, setAttribute: (name: string, value: string) => void attributes.set(name, value) };
}

describe('テストのための読み込みの完了の印（ARC-103-1）', () => {
  it('作った時点で loading を出し、ready にしたら ready を出す', () => {
    const root = fakeRoot();
    const mark = new AppStateMark(root);
    expect(root.attributes.get(APP_STATE_ATTRIBUTE)).toBe('loading');
    expect(mark.state).toBe('loading');
    mark.ready();
    expect(root.attributes.get(APP_STATE_ATTRIBUTE)).toBe('ready');
    expect(mark.state).toBe('ready');
  });

  it('読み込めなかったら error を出す', () => {
    const root = fakeRoot();
    const mark = new AppStateMark(root);
    mark.fail();
    expect(root.attributes.get(APP_STATE_ATTRIBUTE)).toBe('error');
  });

  it('一度 ready か error になったら、あとから別の状態に変えない', () => {
    const ready = fakeRoot();
    const a = new AppStateMark(ready);
    a.ready();
    a.fail();
    expect(ready.attributes.get(APP_STATE_ATTRIBUTE)).toBe('ready');
    const failed = fakeRoot();
    const b = new AppStateMark(failed);
    b.fail();
    b.ready();
    expect(failed.attributes.get(APP_STATE_ATTRIBUTE)).toBe('error');
  });

  it('index.html の <html> は、スクリプトが動く前から data-app-state="loading" を持つ', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    const tag = html.match(/<html\b[^>]*>/)?.[0] ?? '';
    expect(tag).toContain(`${APP_STATE_ATTRIBUTE}="loading"`);
  });
});
