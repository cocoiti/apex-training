import './ui/style.css';
import { FixedStepLoop } from './core/loop';
import { createRandom } from './core/random';
import { performanceTimeSource } from './core/time';
import { fetchMapJson } from './data/maps';
import { loadWeapons } from './data/weapons';
import { attachMouse } from './input/mouse';
import { firstConnectedGamepad, PadInput } from './input/pad';
import { DEFAULT_PAD_SETTINGS } from './input/pad-curve';
import { InputQueue } from './input/queue';
import { interpolateAngles, SceneRenderer } from './render/scene';
import { Gun } from './sim/gun';
import { viewAngles } from './sim/player';
import { Simulation } from './sim/simulation';
import { loadWorld } from './sim/world';
import { applyCrosshair } from './ui/crosshair';
import { watchScreen } from './ui/router';
import { showScreen, showStorageNotice } from './ui/shell';
import { appStorage } from './ui/storage';
import { fillWeaponSelect } from './ui/weapon-choices';

/** 画面の切替とフッターの表示を始める。3D の読み込みに失敗しても画面は出るよう、先に同期で行う。 */
function startShell(): void {
  const notice = document.querySelector<HTMLElement>('#storage-notice');
  if (notice) appStorage.onUnavailable(() => showStorageNotice(notice));
  appStorage.probe();

  // 設定画面の Issue で保存した色と形を渡す。今は既定の色と形。
  const crosshair = document.querySelector<HTMLElement>('.crosshair');
  if (crosshair) applyCrosshair(crosshair);

  const screens = [...document.querySelectorAll<HTMLElement>('[data-screen]')];
  watchScreen(window, (screen) => {
    showScreen(screens, screen);
    if (screen !== 'play' && document.pointerLockElement) document.exitPointerLock();
  });
}

async function start(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#view');
  const status = document.querySelector<HTMLElement>('#status');
  const weaponSelect = document.querySelector<HTMLSelectElement>('#weapon');
  if (!canvas || !status || !weaponSelect) throw new Error('キャンバスがない');

  const loaded = loadWorld(await fetchMapJson('range'));
  if (!loaded.ok) {
    status.textContent = `マップを読み込めない: ${loaded.errors.map((e) => `${e.path} ${e.message}`).join(' / ')}`;
    return;
  }
  const { world } = loaded;

  // 武器の選択肢は一覧から category ごとに分けて出す（WPN-13）。
  const weapons = await loadWeapons();
  const first = weapons[0];
  if (!first) {
    status.textContent = '武器のデータを読み込めない（コンソールを見る）';
    return;
  }

  const input = new InputQueue();
  const sim = new Simulation(world, input);
  let gun = new Gun(first, createRandom(Date.now()));
  sim.addStepHook((w, dt) => gun.step(w, dt));

  fillWeaponSelect(weaponSelect, weapons);
  weaponSelect.value = first.id;
  weaponSelect.addEventListener('change', () => {
    const chosen = weapons.find((w) => w.id === weaponSelect.value);
    if (!chosen) return;
    gun = new Gun(chosen, createRandom(Date.now()));
    world.player.recoilOffset = { yaw: 0, pitch: 0 };
    weaponSelect.blur();
  });

  // FOV は設定画面の Issue で保存した値を渡す。省略すると既定の 90。
  const view = new SceneRenderer(canvas, world);

  // パッドの fire・ads は読んだ時刻で積み、look は固定ステップごとにそのステップの開始時刻で積む（docs/spec/pad.md）。
  const pad = new PadInput({
    emit: (action) => input.push(loop.currentTime(), action),
    settings: () => DEFAULT_PAD_SETTINGS,
  });

  const loop = new FixedStepLoop({
    timeSource: performanceTimeSource,
    update: () => {
      const look = pad.step(sim.dt);
      if (look) input.push(sim.time, look);
      sim.step();
    },
    render: (alpha) => view.render(world, interpolateAngles(sim.previousViewAngles, viewAngles(world.player), alpha)),
  });

  attachMouse(canvas, {
    emit: (action) => input.push(loop.currentTime(), action),
    sensitivity: () => 2,
  });

  window.addEventListener('resize', () => view.resize());
  const hint = 'クリックで照準の操作を始める';

  const tick = () => {
    pad.poll(firstConnectedGamepad(navigator.getGamepads?.() ?? []));
    loop.frame();
    status.textContent = `${gun.weapon.name} 残弾 ${gun.ammo} / ${gun.weapon.magSize} — ${hint}`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

startShell();
void start().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = String(error);
});
