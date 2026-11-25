// 受け入れテストで、ブラウザの画面写し（PNG）の画素を読むための小さな復号器。
// 依存を増やさないよう node:zlib だけで、8 ビットの RGB / RGBA（インターレースなし）を読む。
import { inflateSync } from 'node:zlib';

export interface Image {
  readonly width: number;
  readonly height: number;
  /** 画素 (x, y) の [r, g, b]（0〜255）。 */
  pixel(x: number, y: number): [number, number, number];
}

export function decodePng(data: Buffer): Image {
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG ではない');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) {
        throw new Error(`読めない PNG の形式: depth=${depth} color=${color} interlace=${interlace}`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[src + i]!;
      const a = i >= channels ? out[dst + i - channels]! : 0;
      const b = y > 0 ? out[dst - stride + i]! : 0;
      const c = i >= channels && y > 0 ? out[dst - stride + i - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`読めないフィルタ: ${filter}`);
      }
      out[dst + i] = value & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = Math.round(y) * stride + Math.round(x) * channels;
      return [out[i]!, out[i + 1]!, out[i + 2]!];
    },
  };
}
