import { parseMap, type Box, type MapData, type MapError } from './map';
import { createPlayer, type Player } from './player';

/** シミュレーションの世界。マップの箱とプレイヤーを持つ。 */
export interface World {
  readonly mapId: string;
  readonly boxes: readonly Box[];
  readonly player: Player;
}

export function createWorld(map: MapData): World {
  return {
    mapId: map.id,
    boxes: map.boxes,
    player: createPlayer(map.spawn.position, map.spawn.aim),
  };
}

export type LoadWorldResult = { ok: true; world: World } | { ok: false; errors: MapError[] };

/** マップの JSON の中身から World を作る。読み込みの誤りがあれば World は作らない。 */
export function loadWorld(json: unknown): LoadWorldResult {
  const parsed = parseMap(json);
  if (!parsed.ok) return parsed;
  return { ok: true, world: createWorld(parsed.map) };
}
