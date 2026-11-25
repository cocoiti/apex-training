import { isStandardMapping, STANDARD_LAYOUT, type GamepadLike } from './pad';

/**
 * 画面の操作に使うキーとボタン（docs/spec/screens.md「画面の操作」）。照準と射撃のアクションにはせず、入力の記録にも入れない。
 * 何の操作になるかは画面ごとに src/ui/screen-commands.ts で決める。
 */
export type ScreenControl = 'r' | 'space' | 'q' | 'pad-a' | 'pad-b';

const KEY_CONTROLS: Readonly<Record<string, ScreenControl>> = {
  KeyR: 'r',
  Space: 'space',
  KeyQ: 'q',
};

/** keydown のうち、画面の操作の判断に使う部分。 */
export type KeyLike = Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>;

/**
 * キーボードのキーを画面の操作にする。押し続けたときの繰り返し（repeat）と、修飾キーと一緒に押したとき
 * （ブラウザのショートカット。Ctrl+R での再読み込みなど）は操作にしない。キーの配置によらないよう code で見る。
 */
export function keyControl(event: KeyLike): ScreenControl | undefined {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return undefined;
  return KEY_CONTROLS[event.code];
}

const PAD_CONTROLS: readonly (readonly [number, ScreenControl])[] = [
  [STANDARD_LAYOUT.confirm, 'pad-a'],
  [STANDARD_LAYOUT.back, 'pad-b'],
];

/**
 * パッドの A / × と B / ○ を読み、離した状態から押した状態になったときだけ画面の操作にする。
 * 押し続けても繰り返さないので、画面が変わる前から押し続けていたボタンは、一度離すまで次の画面の操作にならない。
 * パッドをつないだ（標準配置で読めるようになった）ときに押していたボタンも、一度離すまで操作にしない。
 * 標準配置として扱えないパッドでは操作にしない（docs/spec/pad.md）。
 */
export class PadButtons {
  /** 最後に読んだときに押していたボタン。パッドを読めていないときは undefined。 */
  private held: Set<number> | undefined;

  /** パッドの最新の値を読み、押し始めたボタンの操作を返す。描画のたびに呼ぶ。 */
  poll(pad: GamepadLike | null): ScreenControl[] {
    if (!pad || !pad.connected || !isStandardMapping(pad)) {
      this.held = undefined;
      return [];
    }
    const pressed = new Set(PAD_CONTROLS.filter(([index]) => pad.buttons[index]?.pressed === true).map(([index]) => index));
    const before = this.held;
    this.held = pressed;
    if (!before) return [];
    return PAD_CONTROLS.filter(([index]) => pressed.has(index) && !before.has(index)).map(([, control]) => control);
  }
}
