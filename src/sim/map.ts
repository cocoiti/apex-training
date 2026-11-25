import { normalizeAngles, type Angles } from './angles';
import { vec3, type Vec3 } from './vec3';

/** 箱の種類。壁か的か。 */
export type BoxKind = 'wall' | 'target';

/** 軸に平行な直方体。 */
export interface Box {
  readonly id: string;
  readonly kind: BoxKind;
  readonly center: Vec3;
  /** 幅（X）・高さ（Y）・奥行き（Z）。メートル。 */
  readonly size: Vec3;
}

/** 読み込んだマップ。 */
export interface MapData {
  readonly id: string;
  readonly name: string;
  readonly spawn: { readonly position: Vec3; readonly aim: Angles };
  readonly boxes: readonly Box[];
}

/** 読み込みの誤り。path はどの項目が誤りかを示す（例: `boxes[1].kind`）。 */
export interface MapError {
  readonly path: string;
  readonly message: string;
}

export type MapParseResult = { ok: true; map: MapData } | { ok: false; errors: MapError[] };

const BOX_KINDS: readonly BoxKind[] = ['wall', 'target'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * マップの JSON の中身を確かめて MapData にする。誤りがあれば、誤りのある項目をすべて返す。
 * 形式は docs/spec/architecture.md の「マップの形式」。
 */
export function parseMap(json: unknown): MapParseResult {
  const errors: MapError[] = [];
  const fail = (path: string, message: string): undefined => {
    errors.push({ path, message });
    return undefined;
  };

  const readString = (obj: Record<string, unknown>, key: string, path: string): string | undefined => {
    const value = obj[key];
    if (value === undefined) return fail(path, '必須の項目がない');
    if (typeof value !== 'string') return fail(path, '文字列ではない');
    return value;
  };

  const readNumber = (obj: Record<string, unknown>, key: string, path: string): number | undefined => {
    const value = obj[key];
    if (value === undefined) return fail(path, '必須の項目がない');
    if (!isFiniteNumber(value)) return fail(path, '数ではない');
    return value;
  };

  const readVec3 = (obj: Record<string, unknown>, key: string, path: string): Vec3 | undefined => {
    const value = obj[key];
    if (value === undefined) return fail(path, '必須の項目がない');
    if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
      return fail(path, '数 3 つの配列ではない');
    }
    const [x, y, z] = value as [number, number, number];
    return vec3(x, y, z);
  };

  if (!isRecord(json)) {
    return { ok: false, errors: [{ path: '', message: 'オブジェクトではない' }] };
  }

  const id = readString(json, 'id', 'id');
  const name = readString(json, 'name', 'name');

  let spawn: MapData['spawn'] | undefined;
  if (json.spawn === undefined) fail('spawn', '必須の項目がない');
  else if (!isRecord(json.spawn)) fail('spawn', 'オブジェクトではない');
  else {
    const position = readVec3(json.spawn, 'position', 'spawn.position');
    const yaw = readNumber(json.spawn, 'yaw', 'spawn.yaw');
    const pitch = readNumber(json.spawn, 'pitch', 'spawn.pitch');
    if (position && yaw !== undefined && pitch !== undefined) {
      spawn = { position, aim: normalizeAngles(yaw, pitch) };
    }
  }

  const boxes: Box[] = [];
  if (json.boxes === undefined) fail('boxes', '必須の項目がない');
  else if (!Array.isArray(json.boxes)) fail('boxes', '配列ではない');
  else {
    const seen = new Set<string>();
    json.boxes.forEach((raw: unknown, i: number) => {
      const at = `boxes[${i}]`;
      if (!isRecord(raw)) {
        fail(at, 'オブジェクトではない');
        return;
      }
      const boxId = readString(raw, 'id', `${at}.id`);
      if (boxId !== undefined) {
        if (seen.has(boxId)) fail(`${at}.id`, `箱の識別子 "${boxId}" が重複している`);
        seen.add(boxId);
      }

      let kind: BoxKind | undefined;
      if (raw.kind === undefined) fail(`${at}.kind`, '必須の項目がない');
      else if (!BOX_KINDS.includes(raw.kind as BoxKind)) {
        fail(`${at}.kind`, `"wall" または "target" ではない（${JSON.stringify(raw.kind)}）`);
      } else kind = raw.kind as BoxKind;

      const center = readVec3(raw, 'center', `${at}.center`);
      let size = readVec3(raw, 'size', `${at}.size`);
      if (size && !(size.x > 0 && size.y > 0 && size.z > 0)) {
        size = fail(`${at}.size`, '0 以下の値がある');
      }

      if (boxId !== undefined && kind && center && size) boxes.push({ id: boxId, kind, center, size });
    });
  }

  if (errors.length > 0 || id === undefined || name === undefined || !spawn) {
    return { ok: false, errors };
  }
  return { ok: true, map: { id, name, spawn, boxes } };
}
