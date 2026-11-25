import { describe, expect, it } from 'vitest';
import { PracticeFlow } from '../../src/ui/practice-flow';

describe('練習の始まりと終わりの画面', () => {
  it('「開始」を押さずにプレイ画面を開くと、トップ画面になり練習は始まらない', () => {
    const flow = new PracticeFlow();
    expect(flow.enter('play')).toEqual({ screen: 'top', start: false, abort: false });
    expect(flow.practicing).toBe(false);
  });

  it('「開始」を押してからプレイ画面に入ると、練習が始まる', () => {
    const flow = new PracticeFlow();
    flow.requestStart();
    expect(flow.enter('play')).toEqual({ screen: 'play', start: true, abort: false });
    expect(flow.practicing).toBe(true);
  });

  it('「開始」は 1 回の練習にだけ効く。押したあと別の画面に入ると取り消す', () => {
    const flow = new PracticeFlow();
    flow.requestStart();
    flow.enter('settings');
    expect(flow.enter('play').screen).toBe('top');
  });

  it('結果がないときにリザルト画面を開くと、トップ画面になる（UI-3）', () => {
    const flow = new PracticeFlow();
    expect(flow.enter('result')).toEqual({ screen: 'top', start: false, abort: false });
  });

  it('練習を終えるとリザルト画面に入れ、プレイ画面にはもう入れない', () => {
    const flow = new PracticeFlow();
    flow.requestStart();
    flow.enter('play');
    flow.finish();
    expect(flow.practicing).toBe(false);
    expect(flow.enter('result')).toEqual({ screen: 'result', start: false, abort: false });
    expect(flow.enter('play').screen).toBe('top');
  });

  it('練習中にプレイ画面から離れると、その練習を打ち切る', () => {
    const flow = new PracticeFlow();
    flow.requestStart();
    flow.enter('play');
    expect(flow.enter('top')).toEqual({ screen: 'top', start: false, abort: true });
    expect(flow.practicing).toBe(false);
    // 打ち切った練習の結果はないので、リザルト画面には入れない。
    expect(flow.enter('result').screen).toBe('top');
  });

  it('設定などの画面はいつでも開ける', () => {
    const flow = new PracticeFlow();
    expect(flow.enter('settings').screen).toBe('settings');
    expect(flow.enter('settings-pad').screen).toBe('settings-pad');
    expect(flow.enter('top').screen).toBe('top');
  });

  it('UI-36: 終えたセットがないときにセットのまとめを開くと、トップ画面になる', () => {
    const flow = new PracticeFlow();
    expect(flow.enter('set-result')).toEqual({ screen: 'top', start: false, abort: false });
    // 回数が 1 の練習を終えても、セットのまとめには入れない。
    flow.requestStart();
    flow.enter('play');
    flow.finish();
    expect(flow.enter('set-result').screen).toBe('top');
  });

  it('連続練習を終えるとセットのまとめに入れ、練習は打ち切らない', () => {
    const flow = new PracticeFlow();
    flow.requestStart();
    flow.enter('play');
    flow.finishSet();
    expect(flow.practicing).toBe(false);
    expect(flow.enter('set-result')).toEqual({ screen: 'set-result', start: false, abort: false });
    expect(flow.enter('play').screen).toBe('top');
  });

  it('UI-35: セットのまとめから「もう一度」でプレイ画面に入ると、新しい練習が始まる', () => {
    const flow = new PracticeFlow();
    flow.requestStart();
    flow.enter('play');
    flow.finishSet();
    flow.enter('set-result');
    flow.requestStart();
    expect(flow.enter('play')).toEqual({ screen: 'play', start: true, abort: false });
  });
});
