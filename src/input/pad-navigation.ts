import { isStandardMapping, STANDARD_LAYOUT, type GamepadLike } from './pad';

/**
 * パッドでの項目の移動と変更の操作（docs/spec/screens.md「パッドでの項目の移動と変更」）。
 * 十字キー・左スティック・A / ×・B / ○ を読み、画面の項目の操作にする。照準と射撃のアクションにはせず、入力の記録にも入れない。
 * 何の操作になるかは画面ごとに src/ui/pad-menu.ts で決める。
 */
export type NavDirection = 'up' | 'down' | 'left' | 'right';

/** 方向・決定（A / ×）・戻る（B / ○）。 */
export type NavCommand = NavDirection | 'confirm' | 'back';

/** 標準配置の十字キーのボタンの番号（上・下・左・右）。 */
export const DPAD_BUTTONS: Readonly<Record<NavDirection, number>> = { up: 12, down: 13, left: 14, right: 15 };

/** 標準配置の左スティックの軸（左右・上下）。上下は負が上。 */
export const LEFT_STICK_AXES = { x: 0, y: 1 } as const;

/** 左スティックをその向きの十字キーを押した状態とみなす、大きいほうの成分の絶対値。 */
export const NAV_STICK_THRESHOLD = 0.5;

/** 方向を押し続けたときに繰り返し始めるまでの時間（ミリ秒）と、繰り返しの間隔（ミリ秒）。 */
export const NAV_REPEAT_DELAY_MS = 400;
export const NAV_REPEAT_INTERVAL_MS = 100;

const DIRECTIONS: readonly NavDirection[] = ['up', 'down', 'left', 'right'];

/** 左スティックが倒れている向き。大きいほうの成分の絶対値がしきい値より小さければ undefined。同じ大きさなら上下。 */
export function stickDirection(x: number, y: number): NavDirection | undefined {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (Math.max(ax, ay) < NAV_STICK_THRESHOLD) return undefined;
  if (ay >= ax) return y < 0 ? 'up' : 'down';
  return x < 0 ? 'left' : 'right';
}

/** パッドで今押している操作（十字キーか左スティックの方向、A / ×、B / ○）。 */
export function heldCommands(pad: GamepadLike): Set<NavCommand> {
  const held = new Set<NavCommand>();
  const pressed = (index: number) => pad.buttons[index]?.pressed === true;
  const stick = stickDirection(pad.axes[LEFT_STICK_AXES.x] ?? 0, pad.axes[LEFT_STICK_AXES.y] ?? 0);
  for (const direction of DIRECTIONS) {
    if (pressed(DPAD_BUTTONS[direction]) || stick === direction) held.add(direction);
  }
  if (pressed(STANDARD_LAYOUT.confirm)) held.add('confirm');
  if (pressed(STANDARD_LAYOUT.back)) held.add('back');
  return held;
}

/** 押している操作の状態。next は方向を次に繰り返す時刻、blocked は一度離すまで操作にしないか。 */
interface Held {
  next: number;
  blocked: boolean;
}

/**
 * 入力に使うパッドの十字キー・左スティック・A / ×・B / ○ を描画ごとに読み、項目の操作を返す。
 * 押し始めに 1 回操作にし、方向は押し始めから 0.4 秒後から 0.1 秒ごとに繰り返す。A / ×・B / ○ は繰り返さない。
 * block() のときに押していたもの（画面が変わる前から押していたもの）と、パッドを読めるようになったときに押していたものは、
 * 一度離すまで操作にしない。標準配置として扱えないパッドは読まない（docs/spec/screens.md「パッドでの項目の移動と変更」）。
 */
export class PadNavigator {
  /** 最後に読んだときに押していたもの。パッドを読めていないときは undefined。 */
  private held: Map<NavCommand, Held> | undefined;

  /** パッドの最新の値を読み、この描画で操作になったものを順に返す。time はミリ秒（requestAnimationFrame の時刻）。 */
  poll(pad: GamepadLike | null, time: number): NavCommand[] {
    if (!pad || !pad.connected || !isStandardMapping(pad)) {
      this.held = undefined;
      return [];
    }
    const pressed = heldCommands(pad);
    const before = this.held;
    const next = new Map<NavCommand, Held>();
    const commands: NavCommand[] = [];
    for (const command of pressed) {
      const state = before?.get(command);
      if (!before) {
        // 読めるようになったときに押していたものは、一度離すまで操作にしない。
        next.set(command, { next: 0, blocked: true });
        continue;
      }
      if (!state) {
        commands.push(command);
        next.set(command, { next: time + NAV_REPEAT_DELAY_MS, blocked: false });
        continue;
      }
      if (!state.blocked && command !== 'confirm' && command !== 'back') {
        // 1 回の読み取りで繰り返すのは方向ごとに 1 回まで。描画が止まって遅れた分は取り戻さず、次の時刻を今から決め直す。
        if (time >= state.next) {
          commands.push(command);
          state.next += NAV_REPEAT_INTERVAL_MS;
          if (state.next <= time) state.next = time + NAV_REPEAT_INTERVAL_MS;
        }
      }
      next.set(command, state);
    }
    this.held = next;
    return commands;
  }

  /** 今押しているものを、一度離すまで操作にしない。画面が変わったときに呼ぶ。 */
  block(): void {
    for (const state of this.held?.values() ?? []) state.blocked = true;
  }
}
