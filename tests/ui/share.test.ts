import { describe, expect, it, vi } from 'vitest';
import { summarizeSet } from '../../src/ui/set-summary';
import {
  browserShareTarget,
  COPIED_MESSAGE,
  COPY_FAILED_MESSAGE,
  PUBLIC_URL,
  resultShare,
  resultShareText,
  setShare,
  setShareText,
  ShareControl,
  shareText,
  xPostUrl,
  type ShareTarget,
} from '../../src/ui/share';

/** screens.md「シェアの文」の例（L-STAR を反復練習で 1 回、平均ズレ 0.85 度・命中率 72%、自己ベストを更新）。 */
const EXAMPLE = [
  'リコイル練習（非公式ファンツール）の結果',
  '武器: L-STAR / モード: 反復練習',
  '平均ズレ: 0.85° / 命中率: 72.0%',
  '自己ベスト更新！',
  'https://cocoiti.github.io/apex-training/',
].join('\n');

const lstar = { weapon: { name: 'L-STAR' }, mode: { name: '反復練習' } };

const domError = (name: string) => Object.assign(new Error(name), { name });

function elements() {
  return {
    post: { href: '' },
    message: { textContent: '', hidden: true },
    fallback: { value: '', hidden: true },
  };
}

describe('シェアの文（docs/spec/screens.md「シェアの文」）', () => {
  it('UI-87: 自己ベストを更新したリザルト画面の文は、SPEC の例と一致する', () => {
    const text = resultShareText(resultShare(lstar, { meanDeviation: 0.85, hitRate: 72, bestUpdated: true }));
    expect(text).toBe(EXAMPLE);
    expect(text).toContain('非公式ファンツール');
    expect(text).toContain(PUBLIC_URL);
  });

  it('UI-88: 自己ベストを更新しなかったときは「自己ベスト更新！」の行がなく、ほかの行は同じ', () => {
    const text = resultShareText(resultShare(lstar, { meanDeviation: 0.85, hitRate: 72, bestUpdated: false }));
    expect(text.split('\n')).toEqual(EXAMPLE.split('\n').filter((line) => line !== '自己ベスト更新！'));
  });

  it('「なし」の指標は「なし」と書く', () => {
    const text = resultShareText(resultShare(lstar, { meanDeviation: null, hitRate: null, bestUpdated: false }));
    expect(text.split('\n')[2]).toBe('平均ズレ: なし / 命中率: なし');
  });

  it('UI-92: 回数 5 のセットを 3 回目まで終えた文は、セットの見出し・回数とセットの平均ズレ・公開 URL を含む', () => {
    const summary = summarizeSet(
      [
        { round: 1, meanDeviation: 1.0 },
        { round: 2, meanDeviation: 0.8 },
        { round: 3, meanDeviation: 1.2 },
      ],
      5,
    );
    const lines = setShareText(setShare('L-STAR', '反復練習', summary)).split('\n');
    expect(lines).toEqual([
      'リコイル練習（非公式ファンツール）のセットの結果',
      '武器: L-STAR / モード: 反復練習',
      '回数: 3 / 5 回 / セットの平均ズレ: 1.00°',
      PUBLIC_URL,
    ]);
  });

  it('セットのどれかの回で自己ベストを更新したら「自己ベスト更新！」を入れる。セットの平均が「なし」なら「なし」と書く', () => {
    const updated = summarizeSet([{ round: 1, meanDeviation: 0.9, bestUpdated: true }], 5);
    expect(setShareText(setShare('L-STAR', '反復練習', updated)).split('\n')[3]).toBe('自己ベスト更新！');
    const none = summarizeSet([{ round: 1, meanDeviation: null }], 5);
    expect(setShareText(setShare('L-STAR', '反復練習', none)).split('\n')[2]).toBe('回数: 1 / 5 回 / セットの平均ズレ: なし');
  });

  it('OVR-20: 文は「シェアの文」の行だけからなり、ほかの指標・各回の値・入力方式を含まない', () => {
    const text = resultShareText(resultShare(lstar, { meanDeviation: 0.85, hitRate: 72, bestUpdated: true }));
    expect(text).not.toMatch(/グルーピング|横ブレ|縦ブレ|区間|マウス|パッド|補正|軌道/);
    const summary = summarizeSet(
      [
        { round: 1, meanDeviation: 1.0 },
        { round: 2, meanDeviation: 0.8 },
      ],
      5,
    );
    const set = setShareText(setShare('L-STAR', '反復練習', summary));
    // 各回の平均ズレ（1.00°・0.80°）は入れない。入るのはセットの平均（0.90°）だけ。
    expect(set).not.toMatch(/1\.00°|0\.80°|回目/);
    expect(set).toContain('0.90°');
  });

  it('UI-94: 「X に投稿」の行き先は x.com の投稿画面に URL エンコードした文を付けたもの', () => {
    expect(xPostUrl(EXAMPLE)).toBe(`https://x.com/intent/post?text=${encodeURIComponent(EXAMPLE)}`);
    expect(new URL(xPostUrl(EXAMPLE)).searchParams.get('text')).toBe(EXAMPLE);
  });
});

describe('シェアの方法（docs/spec/screens.md「シェアの方法」）', () => {
  it('UI-87, OVR-20: シェアの機能があれば text だけを渡して 1 回だけ呼び、コピーしない', async () => {
    const share = vi.fn<(data: { text: string }) => Promise<void>>(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    expect(await shareText(EXAMPLE, { share, writeText })).toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ text: EXAMPLE });
    expect(Object.keys(share.mock.calls[0]![0])).toEqual(['text']);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('UI-89: シェアの機能がないときはクリップボードにコピーする', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(await shareText(EXAMPLE, { writeText })).toBe('copied');
    expect(writeText).toHaveBeenCalledWith(EXAMPLE);
  });

  it('UI-90: NotAllowedError で失敗したらコピーし、AbortError のときはコピーしない', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    expect(await shareText(EXAMPLE, { share: () => Promise.reject(domError('NotAllowedError')), writeText })).toBe('copied');
    expect(writeText).toHaveBeenCalledWith(EXAMPLE);
    writeText.mockClear();
    expect(await shareText(EXAMPLE, { share: () => Promise.reject(domError('AbortError')), writeText })).toBe('aborted');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('UI-91: コピーもできないときは投げずに failed を返す', async () => {
    expect(await shareText(EXAMPLE, { writeText: () => Promise.reject(domError('NotAllowedError')) })).toBe('failed');
    expect(await shareText(EXAMPLE, {})).toBe('failed');
  });

  it('ブラウザの navigator.share とクリップボードを押した時点で読み、ないものは省く', async () => {
    const share = vi.fn(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    const nav = { share, clipboard: { writeText } } as unknown as Navigator;
    const target = browserShareTarget(nav);
    await target.share?.({ text: 'a' });
    await target.writeText?.('b');
    expect(share).toHaveBeenCalledWith({ text: 'a' });
    expect(writeText).toHaveBeenCalledWith('b');
    const bare = browserShareTarget({} as Navigator);
    expect(bare.share).toBeUndefined();
    expect(bare.writeText).toBeUndefined();
  });
});

describe('結果のシェアの表示', () => {
  const control = (target: ShareTarget) => {
    const els = elements();
    const ctl = new ShareControl(els, () => target);
    ctl.set(EXAMPLE);
    return { els, ctl };
  };

  it('UI-94: 文を決めると「X に投稿」の行き先を変え、メッセージと欄を隠す', () => {
    const { els } = control({});
    expect(els.post.href).toBe(xPostUrl(EXAMPLE));
    expect(els.message.hidden).toBe(true);
    expect(els.fallback.hidden).toBe(true);
  });

  it('UI-89: コピーしたら「コピーしました」と出す', async () => {
    const { els, ctl } = control({ writeText: () => Promise.resolve() });
    expect(await ctl.share()).toBe('copied');
    expect(els.message).toEqual({ textContent: COPIED_MESSAGE, hidden: false });
    expect(els.fallback.hidden).toBe(true);
  });

  it('UI-90: 取りやめたときとシェアしたときはメッセージを出さない', async () => {
    const aborted = control({ share: () => Promise.reject(domError('AbortError')), writeText: () => Promise.resolve() });
    await aborted.ctl.share();
    expect(aborted.els.message.hidden).toBe(true);
    const shared = control({ share: () => Promise.resolve() });
    await shared.ctl.share();
    expect(shared.els.message.hidden).toBe(true);
  });

  it('UI-91: コピーできなかったらメッセージを出し、文を読み取り専用の欄に出す。もう一度押してコピーできたら置き換える', async () => {
    let fail = true;
    const { els, ctl } = control({ writeText: () => (fail ? Promise.reject(domError('NotAllowedError')) : Promise.resolve()) });
    expect(await ctl.share()).toBe('failed');
    expect(els.message).toEqual({ textContent: COPY_FAILED_MESSAGE, hidden: false });
    expect(els.fallback).toEqual({ value: EXAMPLE, hidden: false });
    fail = false;
    await ctl.share();
    expect(els.message.textContent).toBe(COPIED_MESSAGE);
    expect(els.fallback.hidden).toBe(true);
  });

  it('先に押した分の結果があとから届いても、あとで押した分のメッセージを上書きしない', async () => {
    let resolveFirst: () => void = () => {};
    let calls = 0;
    const { els, ctl } = control({
      writeText: () => {
        calls += 1;
        return calls === 1 ? new Promise<void>((resolve) => (resolveFirst = resolve)) : Promise.reject(domError('NotAllowedError'));
      },
    });
    const first = ctl.share();
    await ctl.share();
    resolveFirst();
    await first;
    expect(els.message.textContent).toBe(COPY_FAILED_MESSAGE);
  });

  it('別の結果の文を決めるとメッセージを消す', async () => {
    const { els, ctl } = control({ writeText: () => Promise.resolve() });
    await ctl.share();
    ctl.set('次の文');
    expect(els.message.hidden).toBe(true);
    expect(els.post.href).toBe(xPostUrl('次の文'));
  });
});
