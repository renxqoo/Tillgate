/**
 * Bun 原生服务适配规格(bun-native 形态):port=0 随机端口回传、fetch 往返、
 * env.server 注入(trusted-client-ip 的 socket 取址依赖)、close 回调收口。
 */
import { describe, expect, it } from 'vitest';
import { serveApp } from '../src/network/serve-app.js';

describe('serveApp(Bun.serve 适配)', () => {
  it('随机端口 + fetch 往返 + env.server 注入 + close 回调', async () => {
    const seenEnvs: Array<{ server?: unknown }> = [];
    const app = {
      fetch: (request: Request, env: unknown) => {
        seenEnvs.push(env as { server?: unknown });
        return new Response(`pong ${request.url.includes('/x') ? 'x' : 'root'}`);
      },
    };
    let listeningPort = -1;
    const server = serveApp(app, { port: 0 }, (info) => {
      listeningPort = info.port;
    });
    expect(listeningPort).toBeGreaterThan(0); // 系统分配的实际监听口回传
    const res = await fetch(`http://127.0.0.1:${listeningPort}/x`);
    expect(await res.text()).toBe('pong x');
    expect(typeof seenEnvs[0]?.server).toBe('object'); // hono 上下文携带 Bun server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await expect(fetch(`http://127.0.0.1:${listeningPort}/x`)).rejects.toThrow();
  });

  it('hostname 显式指定分支:仅回环可达', async () => {
    let port = -1;
    const server = serveApp(
      { fetch: () => new Response('lo') },
      { port: 0, hostname: '127.0.0.1' },
      ({ port: actualPort }) => {
        port = actualPort;
      },
    );
    const res = await fetch(`http://localhost:${port}/`);
    expect(await res.text()).toBe('lo');
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
});
