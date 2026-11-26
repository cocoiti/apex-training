import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../src/ui/i18n';
import { StatusMessage } from '../../src/ui/status-message';

const created: StatusMessage[] = [];

function statusLine() {
  const element = { textContent: '' };
  const line = new StatusMessage(element);
  created.push(line);
  return { element, line };
}

afterEach(() => {
  for (const line of created.splice(0)) line.dispose();
  setLanguage('ja');
});

describe('プレイ画面の状態の行', () => {
  it('最後に出した文言を、言語を選び直したら今の言語で書き直す（読み込み中に戻さない）', () => {
    const { element, line } = statusLine();
    line.show('play.loading');
    expect(element.textContent).toBe('読み込み中');
    line.show('play.dataError');
    setLanguage('en');
    expect(element.textContent).toBe("Couldn't load the weapon or mode data (see the console)");
    setLanguage('ja');
    expect(element.textContent).toBe('武器またはモードのデータを読み込めない（コンソールを見る）');
  });

  it('埋め込む値も覚えて書き直す', () => {
    const { element, line } = statusLine();
    line.show('play.mapError', { errors: 'spawn 不正' });
    const ja = element.textContent;
    expect(ja).toContain('spawn 不正');
    setLanguage('en');
    expect(element.textContent).toContain('spawn 不正');
    expect(element.textContent).not.toBe(ja);
  });

  it('辞書にない文字は、言語を選び直してもそのまま残す', () => {
    const { element, line } = statusLine();
    line.show('play.loading');
    line.showText('Error: boom');
    setLanguage('en');
    expect(element.textContent).toBe('Error: boom');
  });

  it('購読をやめたあとは書き直さない', () => {
    const { element, line } = statusLine();
    line.show('play.loading');
    line.dispose();
    setLanguage('en');
    expect(element.textContent).toBe('読み込み中');
  });
});
