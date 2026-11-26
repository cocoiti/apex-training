import { onLanguageChange, t, type MessageKey } from './i18n';

/**
 * プレイ画面の状態の行（#status）の文言。最後に出した辞書のキーと値を覚え、表示の言語を選び直したら今の言語で書き直す
 * （docs/spec/screens.md「表示の言語」）。読み込みの失敗などのあとに言語を変えても、知らせが「読み込み中」に戻らない。
 * 辞書にない文字（起動の失敗の内容）は言語を変えてもそのまま残す。
 */
export class StatusMessage {
  private last: { readonly key: MessageKey; readonly vars: Readonly<Record<string, string | number>> } | undefined;
  private readonly unsubscribe: () => void;

  constructor(private readonly element: Pick<HTMLElement, 'textContent'>) {
    this.unsubscribe = onLanguageChange(() => {
      if (this.last) this.write(t(this.last.key, this.last.vars));
    });
  }

  /** 辞書のキーの文言を今の言語で出し、言語を選び直したときに書き直せるように覚える。 */
  show(key: MessageKey, vars: Readonly<Record<string, string | number>> = {}): void {
    this.last = { key, vars };
    this.write(t(key, vars));
  }

  /** 辞書にない文字をそのまま出す。言語を選び直しても書き直さない。 */
  showText(text: string): void {
    this.last = undefined;
    this.write(text);
  }

  /** 言語の切替の購読をやめる。 */
  dispose(): void {
    this.unsubscribe();
  }

  private write(text: string): void {
    if (this.element.textContent !== text) this.element.textContent = text;
  }
}
