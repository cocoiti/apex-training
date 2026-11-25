import type { Angles } from './angles';

/** 1 発ごとの照準の跳ね上がり（度）。右が +dx、上が +dy。 */
export interface RecoilStep {
  readonly dx: number;
  readonly dy: number;
}

/** 読み込んだ武器データ。形式は docs/spec/weapons.md の「武器データ」。 */
export interface WeaponData {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly version: string;
  readonly source: string;
  readonly rpm: number;
  readonly magSize: number;
  /** 要素数は magSize。JSON で magSize を超えた分は使わないので切り詰める。 */
  readonly pattern: readonly RecoilStep[];
  readonly randomness: number;
  /** 計測した値なら true、仮データなら false。false の武器は武器の一覧に入れない（docs/spec/weapons.md）。 */
  readonly measured: boolean;
}

/** 読み込みの誤り。path はどの項目が誤りかを示す（例: `pattern[3].dx`）。 */
export interface WeaponError {
  readonly path: string;
  readonly message: string;
}

export type WeaponParseResult = { ok: true; weapon: WeaponData } | { ok: false; errors: WeaponError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 武器の JSON の中身を確かめて WeaponData にする。誤りがあれば、誤りのある項目をすべて返す。 */
export function parseWeapon(json: unknown): WeaponParseResult {
  if (!isRecord(json)) {
    return { ok: false, errors: [{ path: '', message: 'オブジェクトではない' }] };
  }
  const errors: WeaponError[] = [];
  const fail = (path: string, message: string): undefined => {
    errors.push({ path, message });
    return undefined;
  };

  const readString = (key: string): string | undefined => {
    const value = json[key];
    if (value === undefined) return fail(key, '必須の項目がない');
    if (typeof value !== 'string') return fail(key, '文字列ではない');
    return value;
  };

  const readNumber = (key: string, valid: (n: number) => boolean, rangeMessage: string): number | undefined => {
    const value = json[key];
    if (value === undefined) return fail(key, '必須の項目がない');
    if (!isFiniteNumber(value)) return fail(key, '数ではない');
    if (!valid(value)) return fail(key, rangeMessage);
    return value;
  };

  const id = readString('id');
  const name = readString('name');
  const category = readString('category');
  const version = readString('version');
  const source = readString('source');
  const rpm = readNumber('rpm', (n) => n > 0, '0 より大きい数ではない');
  const magSize = readNumber('magSize', (n) => Number.isInteger(n) && n >= 1, '1 以上の整数ではない');
  const randomness = readNumber('randomness', (n) => n >= 0, '0 以上の数ではない');
  const readBoolean = (key: string): boolean | undefined => {
    const value = json[key];
    if (value === undefined) return fail(key, '必須の項目がない');
    if (typeof value !== 'boolean') return fail(key, '真偽値ではない');
    return value;
  };
  const measured = readBoolean('measured');

  let pattern: RecoilStep[] | undefined;
  const rawPattern = json.pattern;
  if (rawPattern === undefined) fail('pattern', '必須の項目がない');
  else if (!Array.isArray(rawPattern)) fail('pattern', '配列ではない');
  else {
    const steps: RecoilStep[] = [];
    rawPattern.forEach((raw: unknown, i: number) => {
      const at = `pattern[${i}]`;
      if (!isRecord(raw)) {
        fail(at, 'オブジェクトではない');
        return;
      }
      const { dx, dy } = raw;
      if (dx === undefined) fail(`${at}.dx`, '必須の項目がない');
      else if (!isFiniteNumber(dx)) fail(`${at}.dx`, '数ではない');
      if (dy === undefined) fail(`${at}.dy`, '必須の項目がない');
      else if (!isFiniteNumber(dy)) fail(`${at}.dy`, '数ではない');
      if (isFiniteNumber(dx) && isFiniteNumber(dy)) steps.push({ dx, dy });
    });
    if (magSize !== undefined && rawPattern.length < magSize) {
      fail('pattern', `要素数（${rawPattern.length}）が magSize（${magSize}）より少ない`);
    }
    pattern = steps;
  }

  if (
    errors.length > 0 ||
    id === undefined ||
    name === undefined ||
    category === undefined ||
    version === undefined ||
    source === undefined ||
    rpm === undefined ||
    magSize === undefined ||
    randomness === undefined ||
    measured === undefined ||
    pattern === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    weapon: { id, name, category, version, source, rpm, magSize, pattern: pattern.slice(0, magSize), randomness, measured },
  };
}

/** 武器の JSON 1 つ分。file はファイル名（開発者向けの出力に使う）。 */
export interface WeaponFile {
  readonly file: string;
  readonly json: unknown;
}

/** 武器の一覧から外した JSON と、その誤り。 */
export interface RejectedWeapon {
  readonly file: string;
  readonly errors: readonly WeaponError[];
}

export interface WeaponList {
  /** 武器の一覧（計測した武器データだけ）。並びは渡したファイルの順。 */
  readonly weapons: readonly WeaponData[];
  /** 項目の確認を通った、measured が false の仮データの武器。誤りではないので出力しない。並びは渡したファイルの順。 */
  readonly placeholders: readonly WeaponData[];
  readonly rejected: readonly RejectedWeapon[];
}

/**
 * 武器の JSON の集まりから武器の一覧を作る。誤りのある JSON は一覧から外して rejected に入れ、ほかの武器は残す。
 * 先に読み込んだ武器（仮データの武器も含む）と id が重なる JSON も外す。
 * measured が false の武器は武器の一覧に入れず placeholders に入れる（docs/adr/2026-11-26-measured-flag-hides-placeholder-weapons.md）。
 */
export function buildWeaponList(files: readonly WeaponFile[]): WeaponList {
  const weapons: WeaponData[] = [];
  const placeholders: WeaponData[] = [];
  const rejected: RejectedWeapon[] = [];
  const seen = new Set<string>();
  for (const { file, json } of files) {
    const parsed = parseWeapon(json);
    if (!parsed.ok) {
      rejected.push({ file, errors: parsed.errors });
    } else if (seen.has(parsed.weapon.id)) {
      rejected.push({ file, errors: [{ path: 'id', message: `武器の ID "${parsed.weapon.id}" が重複している` }] });
    } else {
      seen.add(parsed.weapon.id);
      (parsed.weapon.measured ? weapons : placeholders).push(parsed.weapon);
    }
  }
  return { weapons, placeholders, rejected };
}

/** 発射間隔（秒）。60 ÷ rpm。 */
export function fireInterval(weapon: Pick<WeaponData, 'rpm'>): number {
  return 60 / weapon.rpm;
}

/**
 * 理想の補正軌道。i 番目（0 始まり）は i+1 発目で照準を合わせるべき位置で、
 * 1〜i+1 発目の pattern の合計を上下左右に反転したもの（ヨー・ピッチ、度）。要素数は magSize。
 */
export function idealCorrection(weapon: Pick<WeaponData, 'pattern'>): Angles[] {
  let dx = 0;
  let dy = 0;
  return weapon.pattern.map((step) => {
    dx += step.dx;
    dy += step.dy;
    // 0 - x にして、合計が 0 のときに -0 にならないようにする。
    return { yaw: 0 - dx, pitch: 0 - dy };
  });
}

/** 理想の補正速度を求めるときの射撃の状態。 */
export interface IdealRateState {
  /** fire を押しているか。 */
  readonly fire: boolean;
  /** 次に撃つ弾が pattern の何発目（1 始まり）か（Gun の nextPatternShot）。 */
  readonly nextShot: number;
  /** 残弾。0 なら撃ち切った。 */
  readonly ammo: number;
}

/**
 * 理想の補正速度（docs/spec/pad.md「理想の補正速度」）。理想の補正軌道を照準でなぞるための回転速度（ヨー・ピッチ、度/秒）。
 * fire を押していて次に撃つ弾が k 発目（k ≥ 2）のとき、（k 発目 − (k − 1) 発目の理想の補正軌道）÷ 発射間隔。
 * fire を押していない、次に撃つ弾が 1 発目、撃ち切ったときは 0。
 */
export function idealCorrectionRate(weapon: Pick<WeaponData, 'pattern' | 'rpm'>, state: IdealRateState): Angles {
  const zero = { yaw: 0, pitch: 0 };
  if (!state.fire || state.ammo <= 0 || state.nextShot < 2) return zero;
  const ideal = idealCorrection(weapon);
  const current = ideal[state.nextShot - 1];
  const previous = ideal[state.nextShot - 2];
  if (!current || !previous) return zero;
  const interval = fireInterval(weapon);
  // 0 + x にして、差が 0 のときに -0 にならないようにする。
  return { yaw: 0 + (current.yaw - previous.yaw) / interval, pitch: 0 + (current.pitch - previous.pitch) / interval };
}
