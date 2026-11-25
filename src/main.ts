import './ui/style.css';
import { FixedStepLoop } from './core/loop';
import { performanceTimeSource } from './core/time';
import { fetchMapJson } from './data/maps';
import { loadWeapons } from './data/weapons';
import type { Action } from './input/actions';
import { InputSwitch } from './input/input-switch';
import { attachMouse } from './input/mouse';
import type { MouseSettings } from './input/mouse-sensitivity';
import { PadInput } from './input/pad';
import { DEFAULT_PAD_SETTINGS, type PadSettings } from './input/pad-curve';
import { choosePad, isStandardMapping, MAPPING_ITEMS, padDisplayName, padStatusText, type MappingItem, type PadStatus } from './input/pad-layout';
import { PadNavigator } from './input/pad-navigation';
import { canRumble, rumbleShot } from './input/pad-rumble';
import { createSeed, RecordingInput } from './input/recording';
import { keyControl, PadButtons, type ScreenControl } from './input/screen-controls';
import { modes } from './modes/registry';
import type { TrainingMode } from './modes/types';
import { PracticeSession } from './modes/session';
import { GhostMarker } from './render/ghost';
import { ImpactMarks } from './render/impacts';
import { interpolateAngles, SceneRenderer } from './render/scene';
import { parseMap, type MapData } from './sim/map';
import { viewAngles } from './sim/player';
import type { WeaponData } from './sim/weapon';
import { createWorld, type World } from './sim/world';
import { fillCountSelect } from './ui/count-choices';
import { applyCrosshair } from './ui/crosshair';
import { CorrectionPanel, correctionPanelShown, type CorrectionPanelElements } from './ui/correction-panel';
import { fullscreenLabel, toggleFullscreen } from './ui/fullscreen';
import { bindHistoryView, initialHistorySelection, SCORED_MODES, type HistoryElements } from './ui/history-view';
import { renderHud, type HudElements } from './ui/hud';
import { renderCalibration, calibrationRadii, type CalibrationElements } from './ui/pad-calibration';
import { MappingAutoOpen, PadMappingScreen, PadMappingStore } from './ui/pad-mappings';
import { bindCalibrationDeadzone, bindPadSettingsForm, type PadFormBinding, type PadSettingsFormElements } from './ui/pad-settings-form';
import { fillModeSelect } from './ui/mode-choices';
import { PadMenu } from './ui/pad-menu';
import { showPaused, showPointerLockNotice } from './ui/pointer-lock-notice';
import { padGuideState, padGuideVisible, renderPadGuide, type PadGuideElements } from './ui/pad-guide';
import { PracticeFlow } from './ui/practice-flow';
import { applyPracticeSettings } from './ui/practice-settings';
import type { HistorySelection } from './ui/practice-history';
import type { InputMethod } from './ui/personal-best';
import { parsePracticeCount, PracticeSet } from './ui/practice-set';
import { completePractice, renderResult, type ResultElements, type ResultView } from './ui/result-view';
import { renderRoundResult, roundResultTexts, type RoundResultElements } from './ui/round-result';
import { adsAfter, applyReticleColor, showAimDisplay, type AimDisplayElements } from './ui/scope';
import { SCREEN_HASHES, watchScreen, type ScreenId } from './ui/router';
import { screenCommand, type PlayPhase, type ScreenCommand } from './ui/screen-commands';
import { renderSetSummary, setSummaryHeading, summarizeSet, type SetSummaryElements } from './ui/set-summary';
import { effectivePadSettings, loadCommonSettings, loadMouseSettings, loadPadSettings } from './ui/settings';
import { bindSettingsForm, type SettingsFormElements } from './ui/settings-form';
import { showScreen, showStorageNotice } from './ui/shell';
import { appStorage } from './ui/storage';
import { fillWeaponSelect } from './ui/weapon-choices';

/** 読み込みが終わったあとに練習を始め・打ち切るもの。 */
interface App {
  begin(): void;
  abort(): void;
  /** 履歴の画面を開いた。 */
  openHistory(): void;
  /** キーボードかパッドの画面の操作（docs/spec/screens.md「画面の操作」）。今の画面で操作になったら true。 */
  control(control: ScreenControl): boolean;
}

const flow = new PracticeFlow();
/** 読み込みが終わった App。終わる前の画面の操作は捨てる（あとから古い画面の操作として効かないように）。 */
let readyApp: App | undefined;
// 保存したパッドのボタン割り当て。描画のたびに引くのでメモリに持つ（docs/spec/pad.md「ボタン割り当て」）。
const padMappings = new PadMappingStore(appStorage);
/** 描画の時刻ごとに 1 回だけ読んだパッド。パッドの画面と練習が同じ描画で同じ値を使う。 */
let gamepadFrame: { time: number; pads: readonly (Gamepad | null)[] } | undefined;
/** ブラウザが見つけたパッド。Gamepad API がないブラウザでは空。time は requestAnimationFrame の時刻で、同じ時刻なら読み直さない。 */
const readGamepads = (time: number): readonly (Gamepad | null)[] => {
  if (gamepadFrame?.time !== time) gamepadFrame = { time, pads: navigator.getGamepads?.() ?? [] };
  return gamepadFrame.pads;
};
let resolveApp: (app: App) => void = () => {};
const appReady = new Promise<App>((resolve) => {
  resolveApp = resolve;
});

/** 画面の切替とフッターの表示を始める。3D の読み込みに失敗しても画面は出るよう、先に同期で行う。 */
function startShell(): void {
  const notice = document.querySelector<HTMLElement>('#storage-notice');
  if (notice) appStorage.onUnavailable(() => showStorageNotice(notice));
  appStorage.probe();

  applySavedCrosshair();
  startSettingsForm();
  const countSelect = document.querySelector<HTMLSelectElement>('#count');
  if (countSelect) fillCountSelect(countSelect);
  const padScreens = startPadScreens();

  // 「開始」を押したあとにプレイ画面に入ったときだけ練習を始める（docs/spec/screens.md）。
  document.querySelector('#start')?.addEventListener('click', () => flow.requestStart());
  // リザルト画面とセットのまとめの「もう一度」は、トップ画面で選んだままの武器・モード・回数で練習を始める
  // （docs/spec/scoring.md「リザルト画面」、docs/spec/screens.md「セットのまとめ」）。選択はトップ画面の select に残っている。
  document.querySelector('#retry')?.addEventListener('click', () => flow.requestStart());
  document.querySelector('#set-retry')?.addEventListener('click', () => flow.requestStart());

  // 画面の操作のキー。入力方式によらず受け付け、照準と射撃のアクションにはしない（docs/spec/screens.md「画面の操作」）。
  document.addEventListener('keydown', (event) => {
    if (isEditable(event.target)) return;
    const control = keyControl(event);
    if (!control) return;
    // 操作になったキーは、ページのスクロールやボタンの押下にしない。
    if (readyApp?.control(control)) event.preventDefault();
  });

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
    currentScreen = entry.screen;
    // 入れない画面のハッシュはトップに置き換える。そのままだと「開始」でハッシュが変わらず練習を始められない。
    if (entry.screen !== requested) history.replaceState(null, '', SCREEN_HASHES[entry.screen]);
    showScreen(screens, entry.screen);
    padScreens.enter(entry.screen);
    if (entry.screen !== 'play' && document.pointerLockElement) document.exitPointerLock();
    if (entry.abort) void appReady.then((app) => app.abort());
    if (entry.screen === 'history') void appReady.then((app) => app.openHistory());
    if (entry.start) {
      void appReady.then((app) => {
        if (flow.practicing) app.begin();
      });
    }
  });
}

/** 今表示している画面。画面の操作がどの画面の操作になるかを決める。 */
let currentScreen: ScreenId = 'top';

/** 文字を入力する要素か。設定画面の入力欄で R や Q を打ったときは画面の操作にしない。 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** 保存されたクロスヘアの色と形をプレイ画面のクロスヘアに当て、スコープのレティクルも同じ色にする。 */
function applySavedCrosshair(): void {
  const common = loadCommonSettings(appStorage);
  const crosshair = document.querySelector<HTMLElement>('.crosshair');
  if (crosshair) applyCrosshair(crosshair, { shape: common.crosshairShape, color: common.crosshairColor });
  const scope = document.querySelector<HTMLElement>('.scope');
  if (scope) applyReticleColor(scope, common.crosshairColor);
}

/** 腰撃ちのクロスヘアとスコープの表示の要素。どちらかが欠けていれば undefined。 */
function aimDisplayElements(): AimDisplayElements | undefined {
  const crosshair = document.querySelector<HTMLElement>('[data-screen="play"] .crosshair');
  const scope = document.querySelector<HTMLElement>('[data-screen="play"] .scope');
  return crosshair && scope ? { crosshair, scope } : undefined;
}

/** パッド向けのガイドの要素。どれかが欠けていれば undefined。 */
function padGuideElements(): PadGuideElements | undefined {
  const root = document.querySelector<HTMLElement>('[data-screen="play"] .pad-guide');
  const ideal = root?.querySelector<HTMLElement>('[data-guide="ideal"]');
  const current = root?.querySelector<HTMLElement>('[data-guide="current"]');
  const name = root?.querySelector<HTMLElement>('.pad-guide-name');
  return root && ideal && current && name ? { root, ideal, current, name } : undefined;
}

/** 補正のパネルの要素。どれかが欠けていれば undefined。 */
function correctionPanelElements(): CorrectionPanelElements | undefined {
  const root = document.querySelector<HTMLElement>('[data-screen="play"] .correction-panel');
  const svg = root?.querySelector<SVGSVGElement>('svg');
  const axisX = root?.querySelector<SVGLineElement>('[data-panel="axis-x"]');
  const axisY = root?.querySelector<SVGLineElement>('[data-panel="axis-y"]');
  const ideal = root?.querySelector<SVGPolylineElement>('[data-series="ideal"]');
  const own = root?.querySelector<SVGPolylineElement>('[data-series="aim"]');
  const ownDots = root?.querySelector<SVGGElement>('[data-series="aim-shots"]');
  const current = root?.querySelector<SVGCircleElement>('[data-panel="current"]');
  const aim = root?.querySelector<SVGPathElement>('[data-panel="aim"]');
  const heading = root?.querySelector<SVGLineElement>('[data-panel="heading"]');
  return root && svg && axisX && axisY && ideal && own && ownDots && current && aim && heading
    ? { root, svg, axisX, axisY, ideal, own, ownDots, current, aim, heading }
    : undefined;
}

/** 設定画面の各項目に保存された値を出し、変えたらすぐに保存する（docs/spec/screens.md「設定項目」）。 */
function startSettingsForm(): void {
  const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`);
  const elements = {
    inputMethod: byId<HTMLSelectElement>('setting-input-method'),
    fov: byId<HTMLInputElement>('setting-fov'),
    crosshairShape: byId<HTMLSelectElement>('setting-crosshair-shape'),
    crosshairColor: byId<HTMLInputElement>('setting-crosshair-color'),
    ghost: byId<HTMLInputElement>('setting-ghost'),
    correctionPanel: byId<HTMLInputElement>('setting-correction-panel'),
    sound: byId<HTMLInputElement>('setting-sound'),
    dpi: byId<HTMLInputElement>('setting-dpi'),
    sensitivity: byId<HTMLInputElement>('setting-sensitivity'),
    adsMultiplier: byId<HTMLInputElement>('setting-ads-multiplier'),
    cmPer360: byId<HTMLOutputElement>('setting-cm-per-360'),
  };
  // 要素が欠けていても、ほかの画面は動かす。
  if (Object.values(elements).some((element) => !element)) return;
  bindSettingsForm(elements as SettingsFormElements, appStorage);
  // 入力欄で Enter を押してもフォームを送信しない（ページを読み直さない）。
  document.querySelector('#settings-form')?.addEventListener('submit', (event) => event.preventDefault());
}

/** 履歴の画面の要素を集める。欠けていれば null。 */
function historyElements(): HistoryElements | null {
  const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#history-${id}`);
  const elements = {
    weapon: byId<HTMLSelectElement>('weapon'),
    mode: byId<HTMLSelectElement>('mode'),
    input: byId<HTMLSelectElement>('input'),
    averages: byId('averages'),
    plot: byId('plot'),
    list: byId('list'),
    empty: byId('empty'),
    clear: byId<HTMLButtonElement>('clear'),
    unavailable: byId('unavailable'),
    body: byId('body'),
  };
  const confirm = {
    root: byId('confirm'),
    message: byId('confirm-message'),
    ok: byId<HTMLButtonElement>('confirm-ok'),
    cancel: byId<HTMLButtonElement>('confirm-cancel'),
  };
  if ([...Object.values(elements), ...Object.values(confirm)].some((element) => !element)) return null;
  return { ...elements, confirm } as HistoryElements;
}

/** 画面に入ったときに、パッドの画面の表示を保存された値に揃える。 */
interface PadScreens {
  enter(screen: ScreenId): void;
}

/**
 * 設定画面のパッドの区分・キャリブレーション画面・ボタン割り当て画面（docs/spec/pad.md）。練習の読み込みに失敗しても動くよう、
 * 練習とは別に描画のたびにパッドを読む。トップ画面と設定画面では、標準配置でないパッドのボタンでボタン割り当て画面を開く。
 * トップ・設定・履歴・キャリブレーション・ボタン割り当ての画面では、パッドで項目を移動・変更する
 * （docs/spec/screens.md「パッドでの項目の移動と変更」）。
 */
function startPadScreens(): PadScreens {
  const byId = <T extends Element>(id: string) => document.querySelector<T>(`#${id}`);
  const forms: PadFormBinding[] = [];

  const advanced = {
    deadzone: byId<HTMLInputElement>('setting-pad-deadzone'),
    outerThreshold: byId<HTMLInputElement>('setting-pad-outer-threshold'),
    responseCurve: byId<HTMLInputElement>('setting-pad-response-curve'),
    yaw: byId<HTMLInputElement>('setting-pad-yaw'),
    pitch: byId<HTMLInputElement>('setting-pad-pitch'),
    adsYaw: byId<HTMLInputElement>('setting-pad-ads-yaw'),
    adsPitch: byId<HTMLInputElement>('setting-pad-ads-pitch'),
  };
  const padForm = {
    mode: byId<HTMLSelectElement>('setting-pad-mode'),
    simpleLook: byId<HTMLSelectElement>('setting-pad-simple-look'),
    simpleAds: byId<HTMLSelectElement>('setting-pad-simple-ads'),
    simpleCurve: byId<HTMLSelectElement>('setting-pad-simple-curve'),
    vibration: byId<HTMLInputElement>('setting-pad-vibration'),
  };
  if (![...Object.values(advanced), ...Object.values(padForm)].some((element) => !element)) {
    forms.push(bindPadSettingsForm({ ...padForm, advanced } as PadSettingsFormElements, appStorage));
  }
  const settingsStatus = byId<HTMLElement>('settings-pad-status');
  const vibrationNotice = byId<HTMLElement>('settings-pad-vibration-notice');

  // キャリブレーション画面。デッドゾーンの欄を変えると、すぐに円の大きさを変える。
  const calibration = {
    list: byId<HTMLElement>('calibration-list'),
    empty: byId<HTMLElement>('calibration-empty'),
    table: byId<HTMLElement>('calibration-table'),
    status: byId<HTMLElement>('calibration-status'),
    axes: byId<HTMLElement>('calibration-axes'),
    buttons: byId<HTMLElement>('calibration-buttons'),
    stick: byId<Element>('calibration-dot'),
    deadzoneCircle: byId<Element>('calibration-deadzone'),
    outerCircle: byId<Element>('calibration-outer'),
  };
  const calibrationElements = Object.values(calibration).some((element) => !element)
    ? undefined
    : (calibration as CalibrationElements);
  let shownDeadzone = effectivePadSettings(loadPadSettings(appStorage)).deadzone;
  const deadzoneField = byId<HTMLInputElement>('calibration-deadzone-input');
  if (deadzoneField) {
    forms.push(
      bindCalibrationDeadzone(deadzoneField, appStorage, (deadzone) => {
        shownDeadzone = deadzone;
      }),
    );
  }

  // ボタン割り当て画面。
  const mappingScreen = new PadMappingScreen<Gamepad>(padMappings);
  const mappingEmpty = byId<HTMLElement>('mapping-empty');
  const mappingBody = byId<HTMLElement>('mapping-body');
  const mappingTarget = byId<HTMLElement>('mapping-target');
  const mappingSaved = byId<HTMLElement>('mapping-saved');
  const mappingValues = new Map(MAPPING_ITEMS.map((item) => [item, byId<HTMLElement>(`mapping-${item}`)]));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-assign]')) {
    button.addEventListener('click', () => {
      mappingScreen.start(button.dataset.assign as MappingItem);
      button.blur();
    });
  }
  byId<HTMLButtonElement>('mapping-clear')?.addEventListener('click', () => mappingScreen.clear());
  const setText = (element: HTMLElement | null, text: string) => {
    if (element && element.textContent !== text) element.textContent = text;
  };
  const setHidden = (element: HTMLElement | null, hidden: boolean) => {
    if (element && element.hidden !== hidden) element.hidden = hidden;
  };

  /** 前に enter() で入った画面。ボタン割り当て画面を出たことを知るのに使う。 */
  let shownScreen: ScreenId = 'top';
  const autoOpen = new MappingAutoOpen();
  // パッドでの項目の移動と変更。どの画面でも読み（押したままのものを画面をまたいで覚えるため）、項目のある画面でだけ当てる。
  const padNavigator = new PadNavigator();
  const menu = new PadMenu({
    section: (screen) => document.querySelector<HTMLElement>(`[data-screen="${screen}"]`),
    navigate: (screen) => {
      location.hash = SCREEN_HASHES[screen];
    },
  });
  const tick = (time: number) => {
    const pads = readGamepads(time);
    const status = choosePad(pads, padMappings.get);
    // 操作に使うのは入力に使うパッドで、標準配置のときだけ（割り当てを保存した標準配置でないパッドは使わない）。
    const navPad = status.kind === 'using' && isStandardMapping(status.pad) ? status.pad : null;
    const commands = padNavigator.poll(navPad, time);
    // ボタン割り当て画面で操作を待っている間は、項目の移動・決定・戻るを受け付けない。
    menu.frame(currentScreen, commands, currentScreen === 'settings-pad-mapping' && mappingScreen.waiting);
    if (autoOpen.check(currentScreen, pads, status.kind === 'using')) location.hash = SCREEN_HASHES['settings-pad-mapping'];
    if (currentScreen === 'settings') {
      setText(settingsStatus, padStatusText(status));
      setHidden(vibrationNotice, status.kind !== 'using' || canRumble(status.pad));
    } else if (currentScreen === 'settings-pad' && calibrationElements) {
      const outer = effectivePadSettings(loadPadSettings(appStorage)).outerThreshold;
      renderCalibration(calibrationElements, pads, status, padMappings.get, calibrationRadii(shownDeadzone, outer), padStatusText(status));
    } else if (currentScreen === 'settings-pad-mapping') {
      const state = mappingScreen.frame(pads);
      setHidden(mappingEmpty, state.target !== undefined);
      setHidden(mappingBody, state.target === undefined);
      setText(mappingTarget, state.target === undefined ? '' : padDisplayName(state.target));
      for (const item of MAPPING_ITEMS) setText(mappingValues.get(item) ?? null, state.items[item]);
      setText(mappingSaved, state.saved ? 'このパッドの割り当てを保存しました' : '4 つの項目をすべて割り当てると保存します');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    enter: (screen) => {
      if (shownScreen === 'settings-pad-mapping' && screen !== shownScreen) mappingScreen.leave();
      shownScreen = screen;
      // 画面を開いたときはどの項目にもフォーカスがなく、前の画面から押し続けているものは一度離すまで操作にしない。
      menu.enter();
      padNavigator.block();
      if (screen === 'settings' || screen === 'settings-pad') for (const form of forms) form.refresh();
    },
  };
}

/** 1 回の練習の、シミュレーションとループと入力の記録。時刻は練習の開始を 0 とする。 */
interface Running {
  readonly session: PracticeSession;
  readonly loop: FixedStepLoop;
  /** 積んだ入力を記録しながらシミュレーションに流す。記録（input.recording()）はリザルトの軌道の重ね描きと再生に使う。 */
  readonly input: RecordingInput;
  /** この練習に当てたパッドの設定。ガイドとリザルトの入力推移のカーブの逆に使う。 */
  readonly padSettings: Readonly<PadSettings>;
  /** 振動を出し終えた弾の数。 */
  rumbledShots: number;
}

async function start(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#view');
  const status = document.querySelector<HTMLElement>('#status');
  const weaponSelect = document.querySelector<HTMLSelectElement>('#weapon');
  const modeSelect = document.querySelector<HTMLSelectElement>('#mode');
  const countSelect = document.querySelector<HTMLSelectElement>('#count');
  const interlude = document.querySelector<HTMLElement>('#interlude');
  const playControls = document.querySelector<HTMLElement>('#play-controls');
  const quitHint = document.querySelector<HTMLElement>('#play-controls-quit');
  const roundElements: Partial<Record<keyof RoundResultElements, HTMLElement | null>> = {
    round: document.querySelector<HTMLElement>('#interlude-round'),
    score: document.querySelector<HTMLElement>('#interlude-score'),
    best: document.querySelector<HTMLElement>('#interlude-best'),
    countdown: document.querySelector<HTMLElement>('#interlude-countdown'),
  };
  const setElements: Partial<Record<keyof SetSummaryElements, HTMLElement | null>> = {
    heading: document.querySelector<HTMLElement>('#set-summary'),
    rounds: document.querySelector<HTMLElement>('#set-rounds'),
    plot: document.querySelector<HTMLElement>('#set-plot'),
    average: document.querySelector<HTMLElement>('#set-average'),
    best: document.querySelector<HTMLElement>('#set-best'),
  };
  const resultElements: Partial<Record<keyof ResultElements, HTMLElement | null>> = {
    summary: document.querySelector<HTMLElement>('#result-summary'),
    score: document.querySelector<HTMLElement>('#result-score'),
    metrics: document.querySelector<HTMLElement>('#result-metrics'),
    comments: document.querySelector<HTMLElement>('#result-comments'),
    best: document.querySelector<HTMLElement>('#result-best'),
    plots: document.querySelector<HTMLElement>('#result-plots'),
    padTrace: document.querySelector<HTMLElement>('#result-pad'),
  };
  const lockNotice = document.querySelector<HTMLElement>('#pointer-lock-notice');
  const pausedNotice = document.querySelector<HTMLElement>('#paused');
  const hud: Partial<Record<keyof HudElements, HTMLElement | null>> = {
    weapon: document.querySelector<HTMLElement>('[data-hud="weapon"]'),
    ammo: document.querySelector<HTMLElement>('[data-hud="ammo"]'),
    time: document.querySelector<HTMLElement>('[data-hud="time"]'),
    input: document.querySelector<HTMLElement>('[data-hud="input"]'),
    round: document.querySelector<HTMLElement>('[data-hud="round"]'),
    pad: document.querySelector<HTMLElement>('[data-hud="pad"]'),
  };
  if (
    !canvas ||
    !status ||
    !weaponSelect ||
    !modeSelect ||
    !countSelect ||
    !interlude ||
    !playControls ||
    !quitHint ||
    Object.values(roundElements).some((element) => !element) ||
    Object.values(setElements).some((element) => !element) ||
    Object.values(resultElements).some((element) => !element) ||
    !lockNotice ||
    !pausedNotice ||
    !hud.weapon ||
    !hud.ammo ||
    !hud.time ||
    !hud.input ||
    !hud.round ||
    !hud.pad
  ) {
    throw new Error('画面の要素がない');
  }
  const hudElements = hud as HudElements;
  const resultView = resultElements as ResultElements;
  const roundView = roundElements as RoundResultElements;
  const setView = setElements as SetSummaryElements;

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

  // 履歴の画面（docs/spec/screens.md「履歴の画面」）。武器は一覧のすべて、モードは採点するモードだけを選択肢にする。
  // このページで最後に終えた採点するモードの組を、開いたときに選ぶ。
  let lastScored: HistorySelection | null = null;
  const historyEls = historyElements();
  let openHistory = () => {};
  if (historyEls) {
    fillWeaponSelect(historyEls.weapon as HTMLSelectElement, weapons);
    fillModeSelect(historyEls.mode as HTMLSelectElement, SCORED_MODES);
    const historyView = bindHistoryView(historyEls, { storage: appStorage, now: () => new Date() });
    const weaponIds = weapons.map((w) => w.id);
    openHistory = () => historyView.open(initialHistorySelection(lastScored, weaponIds));
  }

  // 練習していないあいだも、トップ画面などの後ろにシーンを描く。
  let shownWorld: World = createWorld(map);
  // FOV は設定画面で保存した値。練習ごとに「開始」を押した時点の値に合わせ直す（docs/spec/screens.md）。
  const view = new SceneRenderer(canvas, shownWorld, { fov: loadCommonSettings(appStorage).fov });
  const impacts = new ImpactMarks(view.view.layer);
  const ghost = new GhostMarker(view.view.layer);
  // パッド向けのガイド（docs/spec/pad.md「練習中のガイド」）。表示だけで、シミュレーションと入力の記録には触れない。
  const guide = padGuideElements();
  const hideGuide = () => {
    if (guide) renderPadGuide(guide, undefined);
  };
  // 補正のパネル（docs/spec/screens.md「補正のパネル」）。表示だけで、シミュレーションと入力の記録には触れない。
  const panelElements = correctionPanelElements();
  const panel = panelElements ? new CorrectionPanel(panelElements) : undefined;
  // 補正のパネルの設定。「開始」を押した時点の保存された値。センター維持だけが使う（反復練習では設定によらず出す）。
  let showPanel = loadCommonSettings(appStorage).correctionPanel;
  // ゴースト表示の設定。「開始」を押した時点の保存された値（docs/spec/screens.md）。OFF でも採点は変わらない。
  let showGhost = loadCommonSettings(appStorage).ghost;
  let running: Running | undefined;
  // マウスの換算に使う DPI・感度・ADS 倍率。「開始」を押した時点の保存された値（docs/spec/mouse.md）。
  let mouseSettings: MouseSettings = loadMouseSettings(appStorage);
  // スティックの換算に使う値と振動の ON/OFF。「開始」を押した時点の保存された値（docs/spec/pad.md「パッドの設定画面」）。
  let padSettings: PadSettings = DEFAULT_PAD_SETTINGS;
  let vibration = true;
  // 入力に使うパッドの状態。描画のたびに選び直す（docs/spec/pad.md「入力に使うパッド」）。
  let padStatus: PadStatus<Gamepad> = { kind: 'missing' };

  // ads を押している間はスコープの表示にする（docs/spec/screens.md「ADS 中の照準」）。シミュレーションの状態ではなく、
  // 積んだ入力から決める。一時停止でステップが進まなくても、ロックが外れて ads を離した時点で腰撃ちの表示に戻すため。
  const aimDisplay = aimDisplayElements();
  let adsHeld = false;
  const setAds = (held: boolean) => {
    adsHeld = held;
    if (aimDisplay) showAimDisplay(aimDisplay, held);
  };
  setAds(false);

  // 設定で選んだ入力方式。「開始」を押した時点の保存された値（docs/spec/input.md「入力方式の切替」）。
  let inputPreference = loadCommonSettings(appStorage).inputMethod;

  // 入力はこの 1 か所で練習の入力のキューに積む。時刻を省いたものはループの時計の今の時刻で積む。
  const push = (action: Action, time?: number) => {
    if (!running) return;
    running.input.push(time ?? running.loop.currentTime(), action);
    if (action.type === 'ads') setAds(adsAfter(adsHeld, action));
  };
  // 今の入力方式のデバイスのアクションだけを積む。今の入力方式はページを開いている間、練習をまたいで引き継ぐ。
  const inputs = new InputSwitch({ preference: () => inputPreference, emit: push });
  // 操作とみなすのはプレイ画面を表示している間の入力だけ。メニューをパッドで操作しても今の入力方式は変えない
  // （docs/spec/input.md「入力方式の切替」）。
  const activity = (device: InputMethod) => {
    if (currentScreen === 'play') inputs.activity(device);
  };
  // パッドの fire・ads は読んだ時刻で積み、look は固定ステップごとにそのステップの開始時刻で積む（docs/spec/pad.md）。
  const pad = new PadInput({
    emit: (action) => inputs.input('pad', action),
    settings: () => padSettings,
    onActivity: () => activity('pad'),
  });

  // 今のセット（回数が 1 のときも 1 回のセットとして持つ）と、その武器とモード。回ごと・やり直しごとに同じものを使う。
  let set: PracticeSet | undefined;
  let setup: { readonly weapon: WeaponData; readonly mode: TrainingMode } | undefined;
  // セットで最後に終えた回の入力方式（1 発目を撃ったときの入力方式）。セットのまとめに表示する。
  let setInput: InputMethod = 'mouse';
  // 直前に終えた回のリザルト。短いリザルトの残り秒数を描き直すのに使う。
  let lastRound: ResultView | undefined;
  // 短いリザルトの時間はシミュレーションの時刻ではなく、ページの時計で数える。
  const now = () => performanceTimeSource.now();

  /** 今のセットの今の回の練習を最初から始める。やり直しもこれで始め直す（docs/spec/modes.md「やり直し」）。 */
  const startRound = () => {
    if (!setup) return;
    const { weapon, mode } = setup;
    impacts.clear();
    ghost.hide();
    const settings = applyPracticeSettings(appStorage, {
      view: view.view,
      crosshair: document.querySelector<HTMLElement>('.crosshair'),
    });
    // スコープのレティクルも、開始時のクロスヘアの色にする。
    const scope = document.querySelector<HTMLElement>('.scope');
    if (scope) applyReticleColor(scope, loadCommonSettings(appStorage).crosshairColor);
    showGhost = settings.ghost;
    showPanel = settings.correctionPanel;
    mouseSettings = settings.mouse;
    padSettings = settings.pad;
    vibration = settings.vibration;
    inputPreference = loadCommonSettings(appStorage).inputMethod;
    inputs.resetHeld();
    // 練習ごとに種を 1 つ決め、積んだ入力を記録する（docs/spec/input.md「入力の記録と再生」）。記録はメモリの中だけで持つ。
    const input = new RecordingInput(createSeed());
    const world = createWorld(map);
    const session = new PracticeSession({
      world,
      weapon,
      mode,
      input,
      seed: input.seed,
      inputMethod: () => inputs.current,
      padName: () => pad.name,
    });
    const loop = new FixedStepLoop({
      timeSource: performanceTimeSource,
      update: () => {
        const look = pad.step(session.sim.dt);
        if (look) inputs.input('pad', look, session.sim.time);
        session.step();
      },
      render: (alpha) => {
        // 撃ち切ったときと練習が終わったときはゴーストを消す（session.ghost が undefined）。
        ghost.update(world.player.position, showGhost ? session.ghost : undefined);
        view.render(world, interpolateAngles(session.previousViewAngles, viewAngles(world.player), alpha));
      },
    });
    shownWorld = world;
    running = { session, loop, input, padSettings: DEFAULT_PAD_SETTINGS, rumbledShots: 0 };
    hideGuide();
    // 新しい練習では自分の線を消し、今の発の点を 1 発目に戻す。表示は描画のたびに決める。
    panel?.begin(weapon);
    panel?.hide();
    setAds(false);
    interlude.hidden = true;
    playControls.hidden = false;
    showPaused(pausedNotice, false);
  };

  /** トップ画面で選んだ武器・モード・回数で、新しいセットを 1 回目から始める。 */
  const begin = () => {
    const weapon = weapons.find((w) => w.id === weaponSelect.value) ?? weapons[0];
    const mode = modes.find((m) => m.id === modeSelect.value) ?? modes[0];
    if (!weapon || !mode) return;
    setup = { weapon, mode };
    set = new PracticeSet(parsePracticeCount(countSelect.value));
    quitHint.hidden = !set.isSet;
    startRound();
  };

  const abort = () => {
    running = undefined;
    setAds(false);
    set = undefined;
    setup = undefined;
    interlude.hidden = true;
    impacts.clear();
    ghost.hide();
    hideGuide();
    panel?.hide();
  };

  /** 終えた回だけのセットのまとめを出す（docs/spec/screens.md「セットのまとめ」）。 */
  const showSetSummary = (current: PracticeSet) => {
    if (!setup) return;
    running = undefined;
    interlude.hidden = true;
    const summary = summarizeSet(current.rounds, current.count);
    renderSetSummary(setView, setSummaryHeading(setup.weapon.name, setup.mode.name, setInput, summary), summary);
    flow.finishSet();
    location.hash = SCREEN_HASHES['set-result'];
  };

  const showInterlude = (current: PracticeSet, round: ResultView) => {
    renderRoundResult(roundView, roundResultTexts(current.round, current.count, round, current.interludeRemaining(now())));
    interlude.hidden = false;
    playControls.hidden = true;
  };

  const finish = (current: Running) => {
    const result = current.session.result;
    if (!result || !set || set.phase !== 'playing') return;
    running = undefined;
    ghost.hide();
    hideGuide();
    panel?.hide();
    setAds(false);
    // 採点し、採点するモードなら自己ベストを保存する。連続練習でも回ごとに判定する（docs/spec/scoring.md「自己ベスト」）。
    // 保存できなくても投げず、フッターの表示は appStorage が出す。
    const view = completePractice(
      {
        result,
        recording: current.input.recording(),
        world: current.session.world,
        input: result.inputMethod,
        dt: current.session.sim.dt,
        padSettings: current.padSettings,
      },
      appStorage,
      new Date(),
    );
    if (result.modeResult.scored) lastScored = { input: result.inputMethod, weaponId: result.weapon.id, modeId: result.mode.id };
    setInput = result.inputMethod;
    const phase = set.completeRound(view.meanDeviation, now());
    if (!set.isSet) {
      renderResult(resultView, view);
      flow.finish();
      location.hash = SCREEN_HASHES.result;
      return;
    }
    if (phase === 'done') {
      showSetSummary(set);
      return;
    }
    lastRound = view;
    showInterlude(set, view);
  };

  /** 短いリザルトを終えて次の回を始める。 */
  const nextRound = () => {
    if (set?.next()) startRound();
  };

  /** セットをやめる。終えた回があればセットのまとめ、なければトップ画面（docs/spec/modes.md「連続練習（セット）」）。 */
  const quit = () => {
    if (!set) return;
    const current = set;
    running = undefined;
    panel?.hide();
    if (current.quit() === 'summary') showSetSummary(current);
    else location.hash = SCREEN_HASHES.top;
  };

  const playPhase = (): PlayPhase => {
    if (running) return running.loop.paused ? 'paused' : 'practicing';
    return set?.phase === 'interlude' ? 'interlude' : 'idle';
  };

  const run = (command: ScreenCommand) => {
    switch (command) {
      case 'restart':
        startRound();
        return;
      case 'next':
        nextRound();
        return;
      case 'quit':
        quit();
        return;
      case 'again':
        // 「もう一度」のリンクと同じく、選んだままの武器・モード・回数で始める。
        flow.requestStart();
        location.hash = SCREEN_HASHES.play;
        return;
      case 'change-weapon':
        location.hash = SCREEN_HASHES.top;
        return;
    }
  };

  const control = (pressed: ScreenControl): boolean => {
    const command = screenCommand({ screen: currentScreen, play: playPhase(), inSet: set?.isSet ?? false }, pressed);
    if (command) run(command);
    return command !== undefined;
  };

  // 設定していなければ既定値（MOU-11）。ロックが外れたら練習を止め、ロックし直したら再開する（docs/spec/mouse.md「一時停止と再開」）。
  attachMouse(canvas, {
    emit: (action) => inputs.input('mouse', action),
    onActivity: () => activity('mouse'),
    settings: () => mouseSettings,
    onLockResult: (result) => showPointerLockNotice(lockNotice, result),
    onLockChange: (locked) => {
      if (!running) return;
      if (locked) running.loop.resume();
      else running.loop.pause();
      showPaused(pausedNotice, !locked);
    },
  });

  // 入力に使うパッドで弾が 1 発出るたびに 1 回振動させる。マウスのとき・OFF のとき・対応しないときは出さない（docs/spec/pad.md「振動」）。
  const rumbleNewShots = (current: Running) => {
    const shots = current.session.gun.shots.length;
    for (; current.rumbledShots < shots; current.rumbledShots += 1) {
      if (vibration && inputs.current === 'pad' && padStatus.kind === 'using') rumbleShot(padStatus.pad);
    }
  };

  window.addEventListener('resize', () => view.resize());
  const hint = 'クリックで照準の操作を始める（パッドは右スティックと R2 / RT）';

  // パッドの A / × と B / ○ は、どの画面でも読み、押し始めだけを画面の操作にする（docs/spec/screens.md「画面の操作」）。
  const padButtons = new PadButtons();

  const tick = (time: number) => {
    padStatus = choosePad(readGamepads(time), padMappings.get);
    const gamepad = padStatus.kind === 'using' ? padStatus.pad : null;
    // 一時停止中も読み、押し始めを捨てる（再開したあとに、止めていた間の押下が操作にならないように）。
    for (const pressed of padButtons.poll(gamepad)) control(pressed);
    // 止めている間はパッドも読まない（再開したときに今の状態を読み直す）。使えるパッドがなければ入力はないものとする。
    if (!running?.loop.paused) {
      if (padStatus.kind === 'using') pad.poll(padStatus.pad, padStatus.layout);
      else pad.poll(null);
    }
    const current = running;
    if (current) {
      current.loop.frame();
      const { session } = current;
      rumbleNewShots(current);
      impacts.sync(session.gun.shots, session.world.player.position);
      renderHud(hudElements, {
        weaponName: session.weapon.name,
        ammo: session.gun.ammo,
        magSize: session.weapon.magSize,
        elapsed: session.elapsed,
        inputMethod: inputs.current,
        round: set ? { index: set.round, count: set.count } : undefined,
        padStatus: inputPreference === 'mouse' ? undefined : padStatusText(padStatus, true),
      });
      // 入力方式がマウスに変わったら、同じ描画ですぐにガイドを消す。撃ち切ったとき・終わったときは session.ghost が undefined。
      if (guide) {
        const shown = padGuideVisible({ ghostShown: session.ghost !== undefined, inputMethod: inputs.current });
        renderPadGuide(
          guide,
          shown
            ? padGuideState({
                idealRate: session.idealRate,
                ads: session.world.player.ads,
                settings: current.padSettings,
                stick: pad.stickValue,
                name: pad.name,
              })
            : undefined,
        );
      }
      // 補正のパネルは入力方式によらず、反復練習では必ず、センター維持では設定が ON なら出す。一時停止中は状態が変わらないので同じ表示のまま。
      if (panel) {
        if (correctionPanelShown(session.mode.correctionPanel, showPanel)) {
          panel.update({ nextShot: session.gun.nextPatternShot, ammo: session.gun.ammo, shotAims: session.shotAims, aim: session.aim });
        } else {
          panel.hide();
        }
      }
      status.textContent = hint;
      // 最後の弾の弾痕を記録・表示したあとにリザルト画面へ移る。
      if (session.result) finish(current);
    } else {
      // 短いリザルトの表示中は残り秒数を描き直し、時間が過ぎたら何もしなくても次の回を始める。
      if (set?.phase === 'interlude') {
        if (set.interludeElapsed(now())) nextRound();
        else if (lastRound) showInterlude(set, lastRound);
      }
      view.render(shownWorld, viewAngles(shownWorld.player));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  readyApp = { begin, abort, openHistory, control };
  resolveApp(readyApp);
}

startShell();
void start().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = String(error);
});
