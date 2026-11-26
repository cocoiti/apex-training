import { afterEach, describe, expect, it } from 'vitest';
import flick, { FLICK_SCORING, TIME_PER_HIT_METRIC } from '../../src/modes/aim/flick';
import { modes } from '../../src/modes/registry';
import { ON_TARGET_RATE_METRIC } from '../../src/modes/tracking';
import { modeOptionChoices } from '../../src/modes/types';
import { simplePattern } from '../../src/sim/simple-pattern';
import { segmentLabel } from '../../src/ui/correction-panel';
import { formatHistoryTime, historyListHtml } from '../../src/ui/history-view';
import { formatElapsed } from '../../src/ui/hud';
import {
  browserLanguage,
  chooseLanguage,
  currentLanguage,
  initialLanguage,
  LANGUAGE_KEY,
  loadLanguage,
  localize,
  onLanguageChange,
  parseLanguage,
  setLanguage,
  t,
} from '../../src/ui/i18n';
import { formatMetric, HIT_RATE_METRIC, SHOT_DEVIATION_COLUMNS, SHOT_DEVIATION_METRIC } from '../../src/ui/mode-scoring';
import { applyPageLanguage, bindLanguageField } from '../../src/ui/page-language';
import { commentText, metricRows } from '../../src/ui/result-view';
import { optionText } from '../../src/ui/result-summary';
import { roundResultTexts } from '../../src/ui/round-result';
import { resultShare, resultShareText, setShare, setShareText, shotDeviationShareScore } from '../../src/ui/share';
import { summarizeSet } from '../../src/ui/set-summary';
import { SafeStorage } from '../../src/ui/storage';
import { score } from '../../src/sim/scoring';

afterEach(() => setLanguage('ja'));

/** 書き込みが例外になる localStorage（保存できない環境）。 */
function failingStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: () => null,
    getItem: (key) => items.get(key) ?? null,
    setItem: () => {
      throw new DOMException('quota', 'QuotaExceededError');
    },
    removeItem: (key) => void items.delete(key),
  };
}

describe('最初の言語（docs/spec/screens.md「最初の言語」）', () => {
  it.each([
    ['ja', 'ja'],
    ['ja-JP', 'ja'],
    ['JA-jp', 'ja'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['fr', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ] as const)('ブラウザの言語 %s は %s', (language, expected) => {
    expect(browserLanguage(language)).toBe(expected);
  });

  it('保存した言語が ja・en ならそれを使い、ほかの値・ないときはブラウザの言語で決める', () => {
    expect(initialLanguage('en', 'ja-JP')).toBe('en');
    expect(initialLanguage('ja', 'en-US')).toBe('ja');
    expect(initialLanguage('de', 'ja-JP')).toBe('ja');
    expect(initialLanguage(null, 'en-US')).toBe('en');
    expect(parseLanguage('EN')).toBeUndefined();
  });

  it('UI-126: 言語を選び直すと apex-training:language に保存され、次に開いたとき（ブラウザが ja-JP でも）その言語になる', () => {
    const items = new Map<string, string>();
    const backing = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: () => {} } as unknown as Storage;
    chooseLanguage(new SafeStorage(() => backing), 'en');
    expect(items.get(LANGUAGE_KEY)).toBe('en');
    setLanguage('ja');
    expect(loadLanguage(new SafeStorage(() => backing), 'ja-JP')).toBe('en');
    expect(currentLanguage()).toBe('en');
  });

  it('UI-134: 保存できない環境でも、選び直すと投げずにすぐその言語になり、ページを開いている間はその言語のまま', () => {
    const storage = new SafeStorage(failingStorage);
    expect(() => chooseLanguage(storage, 'en')).not.toThrow();
    expect(currentLanguage()).toBe('en');
    expect(storage.unavailable).toBe(true);
    expect(initialLanguage(storage.get(LANGUAGE_KEY), 'ja-JP')).toBe('en');
  });
});

describe('言語の切替', () => {
  it('変わったときだけ登録した関数を呼び、外した関数は呼ばない', () => {
    const calls: string[] = [];
    const off = onLanguageChange((language) => calls.push(language));
    setLanguage('ja');
    setLanguage('en');
    setLanguage('en');
    off();
    setLanguage('ja');
    expect(calls).toEqual(['en']);
  });

  it('文言の埋め込む場所を値で置き換え、渡さない名前はそのまま残す', () => {
    expect(t('mode.flickTargets', { done: 3, total: 20 })).toBe('的: 3 / 20');
    setLanguage('en');
    expect(t('mode.flickTargets', { done: 3, total: 20 })).toBe('Targets: 3 / 20');
    expect(t('mode.flickTargets', { done: 3 })).toBe('Targets: 3 / {total}');
    expect(localize({ ja: '反復練習', en: 'Recoil Drill' })).toBe('Recoil Drill');
  });

  it('UI-126・UI-131: 言語の欄は今の言語を出し、English を選ぶとすぐに英語になり、ほかから変わったときも欄の値が合う', () => {
    const listeners: (() => void)[] = [];
    const field = { value: '', addEventListener: (_: 'change', listener: () => void) => void listeners.push(listener) };
    const storage = new SafeStorage(failingStorage);
    bindLanguageField(field, storage);
    expect(field.value).toBe('ja');
    field.value = 'en';
    for (const listener of listeners) listener();
    expect(currentLanguage()).toBe('en');
    setLanguage('ja');
    expect(field.value).toBe('ja');
  });

  it('UI-125・UI-126: 文書の辞書のキーを持つ要素の文字と属性を今の言語にし、<html lang> とタイトルを合わせる', () => {
    const element = (attrs: Record<string, string>) => {
      const attributes = new Map(Object.entries(attrs));
      return {
        textContent: '',
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        attributes,
      };
    };
    const start = element({ 'data-i18n': 'top.start' });
    const share = element({ 'data-i18n-aria-label': 'share.textLabel' });
    const doc = {
      documentElement: { lang: 'ja' },
      title: '',
      querySelectorAll: (selector: string) => (selector === '[data-i18n]' ? [start] : selector === '[data-i18n-aria-label]' ? [share] : []),
    };
    setLanguage('en');
    applyPageLanguage(doc as unknown as Document);
    expect([start.textContent, share.attributes.get('aria-label'), doc.documentElement.lang, doc.title]).toEqual([
      'Start',
      'Share text',
      'en',
      'Hyper Aim Training (Unofficial)',
    ]);
    setLanguage('ja');
    applyPageLanguage(doc as unknown as Document);
    expect([start.textContent, share.attributes.get('aria-label'), doc.documentElement.lang, doc.title]).toEqual([
      '開始',
      'シェアの文',
      'ja',
      'Hyper Aim Training（非公式）',
    ]);
  });
});

describe('英語の文言', () => {
  it('MODE-57: モードは Recoil Drill・Tracking・Tracking + Recoil・Flick の順で、英語のひとこと説明を持つ', () => {
    setLanguage('en');
    expect(modes.map((m) => [localize(m.name), localize(m.description)])).toEqual([
      ['Recoil Drill', "Fire the same weapon's recoil again and again until the pattern is in your hands"],
      ['Tracking', 'Keep your crosshair on a target moving left and right'],
      ['Tracking + Recoil', 'Keep your crosshair on a moving target while controlling recoil'],
      ['Flick', 'Snap to targets that appear at random spots and shoot fast'],
    ]);
    expect(flick.options?.map((o) => [localize(o.label), o.choices.map((c) => localize(c.name))])).toEqual([
      ['Spawn range', ['Near', 'Normal', 'Far']],
      ['Target size', ['Large', 'Medium', 'Small']],
    ]);
    const tracking = modes.find((m) => m.id === 'tracking');
    expect(tracking?.options?.[0]?.choices.map((c) => localize(c.name))).toEqual(['Slow', 'Normal', 'Fast']);
    expect(localize(tracking!.options![0]!.label)).toBe('Speed');
  });

  it('UI-128: L-STAR の反復練習で平均ズレ 0.85 度・命中率 72%・自己ベスト更新のシェアの文が、英語のシェアの文の例と一致する', () => {
    setLanguage('en');
    const lstar = { weapon: { name: 'L-STAR' }, mode: { name: { ja: '反復練習', en: 'Recoil Drill' } } };
    expect(resultShareText(resultShare(lstar, { shareScore: shotDeviationShareScore(0.85, 72), bestUpdated: true }))).toBe(
      [
        'Hyper Aim Training (unofficial fan tool) result',
        'Weapon: L-STAR / Mode: Recoil Drill',
        'Avg. error: 0.85° / Hit rate: 72.0%',
        'New personal best!',
        'https://cocoiti.github.io/apex-training/',
      ].join('\n'),
    );
  });

  it('UI-129: フリック（遠い・小）のシェアの文の 2 行目は選択肢の英語の名前、3 行目は Time per hit と Hit rate', () => {
    setLanguage('en');
    const options = modeOptionChoices(flick, { 'flick-range': 'far', 'flick-size': 'small' }).map((s) => ({ label: s.option.label, name: s.choice.name }));
    const scored = FLICK_SCORING.score({
      shots: [],
      duration: 10,
      modeResult: { targets: [{ time: 0.5, hit: true, error: 0.2 }, { time: 0.546, hit: true, error: 0.1 }] },
    });
    const lines = resultShareText(resultShare({ weapon: undefined, mode: flick, options }, { shareScore: scored.share!, bestUpdated: false })).split('\n');
    expect(lines[1]).toBe('Mode: Flick / Spawn range: Far / Target size: Small');
    expect(lines[2]).toMatch(/^Time per hit: \d+\.\d{3} s \/ Hit rate: \d+\.\d%$/);
    expect(lines[2]).toBe('Time per hit: 0.523 s / Hit rate: 100.0%');
  });

  it('英語のセットのシェアの文は Rounds と Set の平均を書く', () => {
    setLanguage('en');
    const summary = summarizeSet(
      [
        { round: 1, value: 1.2 },
        { round: 2, value: 0.8 },
        { round: 3, value: 1.0 },
      ],
      5,
    );
    expect(setShareText(setShare('L-STAR', 'Recoil Drill', summary)).split('\n').slice(0, 3)).toEqual([
      'Hyper Aim Training (unofficial fan tool) set result',
      'Weapon: L-STAR / Mode: Recoil Drill',
      'Rounds: 3 / 5 / Set avg. error: 1.00°',
    ]);
    const flickSummary = summarizeSet([{ round: 1, value: 0.6 }], 3, TIME_PER_HIT_METRIC);
    expect(setShareText(setShare(undefined, 'Flick', flickSummary)).split('\n')[2]).toBe('Rounds: 1 / 3 / Set avg. time per hit: 0.600 s');
  });

  it('UI-132: 度と割合の書き方は両方の言語で同じで、秒は日本語が「0.523 秒」、英語が「0.523 s」', () => {
    const shown = () => [formatMetric(SHOT_DEVIATION_METRIC, 0.85), formatMetric(HIT_RATE_METRIC, 72), formatMetric(TIME_PER_HIT_METRIC, 0.523)];
    expect(shown()).toEqual(['0.85°', '72.0%', '0.523 秒']);
    setLanguage('en');
    expect(shown()).toEqual(['0.85°', '72.0%', '0.523 s']);
    expect(formatMetric(ON_TARGET_RATE_METRIC, null)).toBe('N/A');
    expect(formatElapsed(2.05)).toBe('2.0 s');
  });

  it('UI-133: 保存した履歴は言語によらず同じ形のまま、英語では指標の名前が英語で出る', () => {
    const entries = [{ version: 1, at: '2026-11-26T10:00:00.000Z', meanError: 0.85, hitRate: 72, groupingRadius: 1.2 }];
    const ja = historyListHtml(entries, SHOT_DEVIATION_METRIC, SHOT_DEVIATION_COLUMNS);
    setLanguage('en');
    const en = historyListHtml(entries, SHOT_DEVIATION_METRIC, SHOT_DEVIATION_COLUMNS);
    expect(ja).toContain('<th>平均ズレ</th>');
    expect(en).toContain('<th>#</th><th>Finished at</th><th>Avg. error</th><th>Hit rate</th><th>Grouping radius</th>');
    expect(en).toContain(`<td>${formatHistoryTime(entries[0]!.at)}</td>`);
    expect(en).toContain('<td data-field="meanError">0.85°</td>');
    expect(en.replace(/<th>[^<]*<\/th>/g, '')).toBe(ja.replace(/<th>[^<]*<\/th>/g, ''));
  });

  it('英語のリザルトの指標・コメント・短いリザルト・簡易版の区切りの言葉', () => {
    setLanguage('en');
    const result = score([{ yaw: 0, pitch: -2 }], 1);
    expect(metricRows(result).map((r) => r.label)).toEqual(['Avg. error', 'Grouping radius', 'Hit rate', 'Error by part', 'Horizontal / vertical spread']);
    expect(result.comments.map(commentText)).toEqual(['Pulling down too much']);
    const round = roundResultTexts(2, 5, { metric: SHOT_DEVIATION_METRIC, value: 0.8, comments: [], bestUpdated: true }, 2.5);
    expect(round).toEqual({ round: 'Round 2 / 5', score: 'Avg. error 0.80°', best: 'New personal best', countdown: 'Next round in 3 s' });
    const segments = simplePattern({ magSize: 10, pattern: Array.from({ length: 10 }, () => ({ dx: 0, dy: 1 })) }).segments;
    expect(segments.map(segmentLabel)).toEqual(['Shots 1-10: ↓ down']);
    setLanguage('ja');
    expect(segments.map(segmentLabel)).toEqual(['1〜10 発: ↓ 下']);
    expect(optionText([{ label: { ja: '速さ', en: 'Speed' }, name: { ja: '速い', en: 'Fast' } }])).toBe('速さ: 速い');
  });
});
