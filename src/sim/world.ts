import type { Angles } from './angles';
import { parseMap, type Box, type MapData, type MapError } from './map';
import { createPlayer, type Player } from './player';
import { PracticeTargets } from './targets';

/** シミュレーションの世界。マップの箱とプレイヤーと、モードが置く練習の的を持つ。 */
export interface World {
  readonly mapId: string;
  readonly boxes: readonly Box[];
  /** 中心（マップの開始時の照準）。弾痕の角度のズレの基準。 */
  readonly center: Angles;
  readonly player: Player;
  /** 練習の的（docs/spec/architecture.md「練習の的」）。World と一緒に練習ごとに作り直すので、ほかの練習に残らない。 */
  readonly targets: PracticeTargets;
}

export function createWorld(map: MapData): World {
  return {
    mapId: map.id,
    boxes: map.boxes,
    center: map.spawn.aim,
    player: createPlayer(map.spawn.position, map.spawn.aim),
    targets: new PracticeTargets(),
  };
}

export type LoadWorldResult = { ok: true; world: World } | { ok: false; errors: MapError[] };

/** マップの JSON の中身から World を作る。読み込みの誤りがあれば World は作らない。 */
export function loadWorld(json: unknown): LoadWorldResult {
  const parsed = parseMap(json);
  if (!parsed.ok) return parsed;
  return { ok: true, world: createWorld(parsed.map) };
}
