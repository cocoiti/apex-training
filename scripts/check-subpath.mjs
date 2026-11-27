// ビルドの結果（dist/）を /apex-training/ のサブパスで配信し、トップと、そこから読み込むスクリプト・スタイル・データが
// 404 にならないことを確かめる（docs/spec/architecture.md ARC-14）。先に npm run build を実行しておく。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const BASE = '/apex-training/';
// 待ち受けのポート。PORT=0 を渡すと空いているポートを OS が選ぶ。
const PORT = Number(process.env.PORT ?? 3102);
const DIST = resolve(import.meta.dirname, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html がない。先に npm run build を実行する。');
  process.exit(1);
}

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (!path.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  let file = normalize(join(DIST, path.slice(BASE.length)));
  if (!file.startsWith(DIST)) {
    res.writeHead(404).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
// PORT=0 のときは OS が選んだ空きのポートで待ち受けるので、実際のポートは listen のあとに読む。
const origin = `http://127.0.0.1:${server.address().port}`;
const failures = [];

async function get(path) {
  const response = await fetch(new URL(path, origin));
  console.log(`${response.status} ${path}`);
  if (!response.ok) failures.push(`${response.status} ${path}`);
  return response.ok ? response.text() : '';
}

try {
  const html = await get(BASE);
  const htmlRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const scripts = [];
  for (const ref of htmlRefs) {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('#')) continue;
    const body = await get(new URL(ref, new URL(BASE, origin)).pathname);
    if (ref.endsWith('.js')) scripts.push(body);
  }
  // スクリプトの中から取得するデータ（マップの JSON など）の URL を拾う。
  const dataRefs = new Set(scripts.flatMap((js) => [...js.matchAll(/["'`](\/apex-training\/[^"'`]+\.json)["'`]/g)].map((m) => m[1])));
  if (dataRefs.size === 0) failures.push('スクリプトの中にデータの URL が見つからない');
  for (const ref of dataRefs) await get(ref);
} finally {
  server.close();
}

if (failures.length > 0) {
  console.error(`読み込めないものがある:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`${BASE} のサブパスですべて読み込めた`);
