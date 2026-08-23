/**
 * 健康端点规格（v1 parity-loops 健康段对位）：livez/readyz 恒开放、
 * /health 令牌门（无/错 token 403、对 token 200 深度报告）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startHealthServer } from '../src/health';
import type { Server } from 'node:http';

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(state: { live: boolean; deep?: Record<string, unknown> }, token?: string) {
  const server = startHealthServer(
    0,
    {
      live: () => state.live,
      ready: () => state.live,
      deep: () => state.deep ?? { owner: 'w-test', running: state.live },
    },
    token,
  );
  servers.push(server);
  return server;
}

function get(server: Server, path: string, headers: Record<string, string> = {}) {
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

describe('健康端点', () => {
  it('livez/readyz 恒开放（状态映射 200/503）', async () => {
    const server = listen({ live: true });
    expect((await get(server, '/livez')).status).toBe(200);
    expect((await get(server, '/readyz')).status).toBe(200);
    const body = await (await get(server, '/livez')).json();
    expect(body).toEqual({ status: 'ok' });
  });

  it('running=false → livez/readyz 503', async () => {
    const server = listen({ live: false });
    expect((await get(server, '/livez')).status).toBe(503);
    expect((await get(server, '/readyz')).status).toBe(503);
  });

  it('/health 无令牌配置（空）或请求缺令牌 → 403；令牌匹配 → 深度报告', async () => {
    const server = listen(
      { live: true, deep: { owner: 'w-1', running: true, jobs: {} } },
      'tok-123',
    );
    expect((await get(server, '/health')).status).toBe(403);
    expect((await get(server, '/health', { 'x-health-token': 'wrong' })).status).toBe(403);
    const ok = await get(server, '/health', { 'x-health-token': 'tok-123' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ owner: 'w-1', running: true, jobs: {} });
  });

  it('/health 未配置令牌（undefined）→ 恒 403（v1 空 token 同形）', async () => {
    const server = listen({ live: true });
    expect((await get(server, '/health')).status).toBe(403);
  });

  it('未知路径 404', async () => {
    const server = listen({ live: true });
    expect((await get(server, '/nope')).status).toBe(404);
  });
});
