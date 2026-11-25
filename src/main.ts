import './ui/style.css';
import { FixedStepLoop } from './core/loop';
import { performanceTimeSource } from './core/time';
import { fetchMapJson } from './data/maps';
import { loadWeapons } from './data/weapons';
import type { Action } from './input/actions';
import { attachMouse } from './input/mouse';
import { DEFAULT_MOUSE_SETTINGS } from './input/mouse-sensitivity';
import { firstConnectedGamepad, PadInput } from './input/pad';
import { DEFAULT_PAD_SETTINGS } from './input/pad-curve';
import { InputQueue } from './input/queue';
import { modes } from './modes/registry';
import { PracticeSession, type PracticeResult } from './modes/session';
import { ImpactMarks } from './render/impacts';
import { interpolateAngles, SceneRenderer } from './render/scene';
import { parseMap, type MapData } from './sim/map';
import { viewAngles } from './sim/player';
import { createWorld, type World } from './sim/world';
import { applyCrosshair } from './ui/crosshair';
import { fullscreenLabel, toggleFullscreen } from './ui/fullscreen';
import { renderHud, type HudElements } from './ui/hud';
import { fillModeSelect } from './ui/mode-choices';
import { showPaused, showPointerLockNotice } from './ui/pointer-lock-notice';
import { PracticeFlow } from './ui/practice-flow';
import { resultSummaryText } from './ui/result-summary';
import { SCREEN_HASHES, watchScreen } from './ui/router';
import { showScreen, showStorageNotice } from './ui/shell';
import { appStorage } from './ui/storage';
import { fillWeaponSelect } from './ui/weapon-choices';

/** 読み込みが終わったあとに練習を始め・打ち切るもの。 */
interface App {
  begin(): void;
  abort(): void;
}

const flow = new PracticeFlow();
let resolveApp: (app: App) => void = () => {};
const appReady = new Promise<App>((resolve) => {
  resolveApp = resolve;
});

/** 画面の切替とフッターの表示を始める。3D の読み込みに失敗しても画面は出るよう、先に同期で行う。 */
function startShell(): void {
  const notice = document.querySelector<HTMLElement>('#storage-notice');
  if (notice) appStorage.onUnavailable(() => showStorageNotice(notice));
  appStorage.probe();

  // 設定画面の Issue で保存した色と形を渡す。今は既定の色と形。
  const crosshair = document.querySelector<HTMLElement>('.crosshair');
  if (crosshair) applyCrosshair(crosshair);

  // 「開始」を押したあとにプレイ画面に入ったときだけ練習を始める（docs/spec/screens.md）。
  document.querySelector('#start')?.addEventListener('click', () => flow.requestStart());

  // 全画面の切替ボタン（docs/spec/mouse.md「全画面」）。
  const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen');
  if (fullscreen) {
    fullscreen.addEventListener('click', () => {
      void toggleFullscreen(document, document.documentElement);
      fullscreen.blur();
    });
    document.addEventListener('fullscreenchange', () => {
      fullscreen.textContent = fullscreenLabel(document);
    });
  }

  const screens = [...document.querySelectorAll<HTMLElement>('[data-screen]')];
  watchScreen(window, (requested) => {
    const entry = flow.enter(requested);
    // 入れない画面のハッシュはトップに置き換える。そのままだと「開始」でハッシュが変わらず練習を始められない。
    if (entry.screen !== requested) history.replaceState(null, '', SCREEN_HASHES[entry.screen]);
    showScreen(screens, entry.screen);
    if (entry.screen !== 'play' && document.pointerLockElement) document.exitPointerLock();
    if (entry.abort) void appReady.then((app) => app.abort());
    if (entry.start) {
      void appReady.then((app) => {
        if (flow.practicing) app.begin();
      });
    }
  });
}

/** 1 回の練習の、シミュレーションとループと入力のキュー。時刻は練習の開始を 0 とする。 */
interface Running {
  readonly session: PracticeSession;
  readonly loop: FixedStepLoop;
  readonly queue: InputQueue;
}

async function start(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#view');
  const status = document.querySelector<HTMLElement>('#status');
  const weaponSelect = document.querySelector<HTMLSelectElement>('#weapon');
  const modeSelect = document.querySelector<HTMLSelectElement>('#mode');
  const summary = document.querySelector<HTMLElement>('#result-summary');
  const lockNotice = document.querySelector<HTMLElement>('#pointer-lock-notice');
  const pausedNotice = document.querySelector<HTMLElement>('#paused');
  const hud: Partial<Record<keyof HudElements, HTMLElement | null>> = {
    weapon: document.querySelector<HTMLElement>('[data-hud="weapon"]'),
    ammo: document.querySelector<HTMLElement>('[data-hud="ammo"]'),
    time: document.querySelector<HTMLElement>('[data-hud="time"]'),
  };
  if (
    !canvas ||
    !status ||
    !weaponSelect ||
    !modeSelect ||
    !summary ||
    !lockNotice ||
    !pausedNotice ||
    !hud.weapon ||
    !hud.ammo ||
    !hud.time
  ) {
    throw new Error('画面の要素がない');
  }
  const hudElements = hud as HudElements;

  const parsed = parseMap(await fetchMapJson('range'));
  if (!parsed.ok) {
    status.textContent = `マップを読み込めない: ${parsed.errors.map((e) => `${e.path} ${e.message}`).join(' / ')}`;
    return;
  }
  const map: MapData = parsed.map;

  // 武器の選択肢は一覧から category ごとに分けて出す（WPN-13、UI-10）。
  const weapons = await loadWeapons();
  if (weapons.length === 0 || modes.length === 0) {
    status.textContent = '武器またはモードのデータを読み込めない（コンソールを見る）';
    return;
  }
  fillWeaponSelect(weaponSelect, weapons);
  weaponSelect.value = weapons[0]?.id ?? '';
  fillModeSelect(modeSelect, modes);

  // 練習していないあいだも、トップ画面などの後ろにシーンを描く。
  let shownWorld: World = createWorld(map);
  // FOV は設定画面の Issue で保存した値を渡す。省略すると既定の 90。
  const view = new SceneRenderer(canvas, shownWorld);
  const impacts = new ImpactMarks(view.view.layer);
  let running: Running | undefined;

  // 入力はこの 1 か所で練習の入力のキューに積む。入力方式の切替（docs/spec/input.md）はここで差し替える。
  const emit = (action: Action) => running?.queue.push(running.loop.currentTime(), action);
  // パッドの fire・ads は読んだ時刻で積み、look は固定ステップごとにそのステップの開始時刻で積む（docs/spec/pad.md）。
  const pad = new PadInput({ emit, settings: () => DEFAULT_PAD_SETTINGS });

  const begin = () => {
    const weapon = weapons.find((w) => w.id === weaponSelect.value) ?? weapons[0];
    const mode = modes.find((m) => m.id === modeSelect.value) ?? modes[0];
    if (!weapon || !mode) return;
    impacts.clear();
    const queue = new InputQueue();
    const world = createWorld(map);
    const session = new PracticeSession({ world, weapon, mode, input: queue, seed: Date.now() });
    const loop = new FixedStepLoop({
      timeSource: performanceTimeSource,
      update: () => {
        const look = pad.step(session.sim.dt);
        if (look) queue.push(session.sim.time, look);
        session.step();
      },
      render: (alpha) => view.render(world, interpolateAngles(session.previousViewAngles, viewAngles(world.player), alpha)),
    });
    shownWorld = world;
    running = { session, loop, queue };
    showPaused(pausedNotice, false);
  };

  const abort = () => {
    running = undefined;
    impacts.clear();
  };

  const finish = (result: PracticeResult) => {
    running = undefined;
    summary.textContent = resultSummaryText(result);
    flow.finish();
    location.hash = SCREEN_HASHES.result;
  };

  // 設定画面の Issue で保存した DPI・感度・ADS 倍率を渡す。今は既定値（MOU-11）。
  // ロックが外れたら練習を止め、ロックし直したら再開する（docs/spec/mouse.md「一時停止と再開」）。
  attachMouse(canvas, {
    emit,
    settings: () => DEFAULT_MOUSE_SETTINGS,
    onLockResult: (result) => showPointerLockNotice(lockNotice, result),
    onLockChange: (locked) => {
      if (!running) return;
      if (locked) running.loop.resume();
      else running.loop.pause();
      showPaused(pausedNotice, !locked);
    },
  });

  window.addEventListener('resize', () => view.resize());
  const hint = 'クリックで照準の操作を始める（パッドは右スティックと R2 / RT）';

  const tick = () => {
    // 止めている間はパッドも読まない（再開したときに今の状態を読み直す）。
    if (!running?.loop.paused) pad.poll(firstConnectedGamepad(navigator.getGamepads?.() ?? []));
    const current = running;
    if (current) {
      current.loop.frame();
      const { session } = current;
      impacts.sync(session.gun.shots, session.world.player.position);
      renderHud(hudElements, {
        weaponName: session.weapon.name,
        ammo: session.gun.ammo,
        magSize: session.weapon.magSize,
        elapsed: session.elapsed,
      });
      status.textContent = hint;
      // 最後の弾の弾痕を記録・表示したあとにリザルト画面へ移る。
      if (session.result) finish(session.result);
    } else {
      view.render(shownWorld, viewAngles(shownWorld.player));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  resolveApp({ begin, abort });
}

startShell();
void start().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = String(error);
});
