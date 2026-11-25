import './ui/style.css';
import { FixedStepLoop } from './core/loop';
import { createRandom } from './core/random';
import { performanceTimeSource } from './core/time';
import { fetchMapJson } from './data/maps';
import { loadWeapons } from './data/weapons';
import { attachMouse } from './input/mouse';
import { InputQueue } from './input/queue';
import { interpolateAngles, SceneRenderer } from './render/scene';
import { Gun } from './sim/gun';
import { viewAngles } from './sim/player';
import { Simulation } from './sim/simulation';
import { loadWorld } from './sim/world';
import { watchScreen } from './ui/router';
import { showScreen, showStorageNotice } from './ui/shell';
import { appStorage } from './ui/storage';
import { fillWeaponSelect } from './ui/weapon-choices';

/** 画面の切替とフッターの表示を始める。3D の読み込みに失敗しても画面は出るよう、先に同期で行う。 */
function startShell(): void {
  const notice = document.querySelector<HTMLElement>('#storage-notice');
  if (notice) appStorage.onUnavailable(() => showStorageNotice(notice));
  appStorage.probe();

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
  const view = new SceneRenderer(canvas, world);

  const loop = new FixedStepLoop({
    timeSource: performanceTimeSource,
    update: () => sim.step(),
    render: (alpha) => view.render(world, interpolateAngles(sim.previousViewAngles, viewAngles(world.player), alpha)),
  });

  attachMouse(canvas, {
    emit: (action) => input.push(loop.currentTime(), action),
    sensitivity: () => 2,
  });

  window.addEventListener('resize', () => view.resize());
  const hint = 'クリックで照準の操作を始める';

  const tick = () => {
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
