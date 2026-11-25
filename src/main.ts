import './ui/style.css';
import { FixedStepLoop } from './core/loop';
import { performanceTimeSource } from './core/time';
import { fetchMapJson } from './data/maps';
import { attachMouse } from './input/mouse';
import { InputQueue } from './input/queue';
import { interpolateAngles, SceneRenderer } from './render/scene';
import { viewAngles } from './sim/player';
import { Simulation } from './sim/simulation';
import { loadWorld } from './sim/world';
import { watchScreen } from './ui/router';
import { showScreen, showStorageNotice } from './ui/shell';
import { appStorage } from './ui/storage';

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
  if (!canvas || !status) throw new Error('キャンバスがない');

  const loaded = loadWorld(await fetchMapJson('range'));
  if (!loaded.ok) {
    status.textContent = `マップを読み込めない: ${loaded.errors.map((e) => `${e.path} ${e.message}`).join(' / ')}`;
    return;
  }
  const { world } = loaded;

  const input = new InputQueue();
  const sim = new Simulation(world, input);
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
  status.textContent = 'クリックで照準の操作を始める';

  const tick = () => {
    loop.frame();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

startShell();
void start().catch((error: unknown) => {
  const status = document.querySelector<HTMLElement>('#status');
  if (status) status.textContent = String(error);
});
