import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSimBoundaryViolations, findViolationsInSource } from '../helpers/sim-boundary';

const SIM_DIR = resolve(__dirname, '../../src/sim');

describe('src/sim/ の独立', () => {
  it('ARC-1: src/sim/ 以下のファイルは three と DOM の API を import・参照していない', () => {
    expect(findSimBoundaryViolations(SIM_DIR)).toEqual([]);
  });

  describe('ARC-4: src/sim/ に three を import するファイルを足すと ARC-1 の確認が失敗する', () => {
    let copy: string | undefined;
    afterEach(() => {
      if (copy) rmSync(copy, { recursive: true, force: true });
      copy = undefined;
    });

    it('three を import するファイルを足した src/sim/ の写しでは違反が見つかる', () => {
      copy = mkdtempSync(join(tmpdir(), 'sim-boundary-'));
      cpSync(SIM_DIR, copy, { recursive: true });
      writeFileSync(join(copy, 'uses-three.ts'), "import * as THREE from 'three';\nexport const v = new THREE.Vector3();\n");

      const violations = findSimBoundaryViolations(copy);
      expect(violations).toContainEqual({ file: 'uses-three.ts', line: 1, reason: '"three" を import している' });
    });
  });

  describe('違反の見つけ方', () => {
    it.each([
      ["import { Vector3 } from 'three';", '"three" を import している'],
      ["import type { Mesh } from 'three';", '"three" を import している'],
      ["export { Vector3 } from 'three';", '"three" を import している'],
      ["import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';", '"three/examples/jsm/controls/OrbitControls.js" を import している'],
      ["const t = await import('three');", '"three" を import している'],
      ["type V = import('three').Vector3;", '"three" を import している'],
      ['const w = window.innerWidth;', 'DOM の API "window" を参照している'],
      ["document.querySelector('canvas');", 'DOM の API "document" を参照している'],
      ['let c: HTMLCanvasElement | null = null;', 'DOM の API "HTMLCanvasElement" を参照している'],
      ['requestAnimationFrame(() => {});', 'DOM の API "requestAnimationFrame" を参照している'],
    ])('%s は違反になる', (source, reason) => {
      expect(findViolationsInSource('a.ts', source).map((v) => v.reason)).toEqual([reason]);
    });

    it.each([
      "import { three } from './three-like';",
      'const o = { document: 1, window: 2 };',
      'const d = state.document;',
      '// window や document と書いたコメント',
      "const s = 'three';",
    ])('%s は違反にならない', (source) => {
      expect(findViolationsInSource('a.ts', source)).toEqual([]);
    });
  });
});
