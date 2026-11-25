// テストが立てるサーバーを、決まったポート番号でなくポート 0（OS が空いているポートを選ぶ）で待ち受けさせる道具
// （docs/spec/architecture.md「テストの実行」、ARC-18, ARC-19）。
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 待ち受けているサーバーの、実際に割り当てられたポート番号。 */
export function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('サーバーが TCP のポートで待ち受けていない');
  return (address as AddressInfo).port;
}

/** 待ち受けているサーバーの origin（http://127.0.0.1:<割り当てられたポート>）。 */
export const originOf = (server: Server) => `http://127.0.0.1:${portOf(server)}`;

/**
 * server をポート 0 で待ち受けさせ、OS に空いているポートを選ばせる。決まった番号で待ち受けないので、
 * 同じマシンでテストを同時に流してもポートを取り合わない（ARC-18, ARC-19）。
 */
export async function listenOnFreePort(server: Server): Promise<Server> {
  await new Promise<void>((ok, ng) => {
    server.once('error', ng);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', ng);
      ok();
    });
  });
  return server;
}
