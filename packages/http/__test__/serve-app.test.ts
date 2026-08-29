/**
 * Bun 原生服务适配规格(bun-native 形态):port=0 随机端口回传、fetch 往返、
 * env.server 注入(trusted-client-ip 的 socket 取址依赖)、close 回调收口,
 * 以及 idleTimeoutSeconds 契约(慢 handler/流式长间隔不被默认空闲窗切断——
 * 回归:OAuth 回调等慢上游曾致反代 502)。
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

/** 慢 handler 应用替身:seconds 秒后才给出响应(模拟等慢上游/流式长间隔) */
const slowApp = (seconds: number) => ({
  fetch: async () => {
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, seconds * 1000);
    });
    return new Response(`slow-${seconds}s`);
  },
});

describe('serveApp idleTimeoutSeconds(空闲切断契约)', () => {
  it('空闲窗小于 handler 时长 → 连接被切断(无响应字节即闲置计数,反代表现为 502)', async () => {
    let port = -1;
    const server = serveApp(slowApp(8), { port: 0, idleTimeoutSeconds: 1 }, ({ port: p }) => {
      port = p;
    });
    const started = Date.now();
    // 响应应在 8s 才到达;空闲 1s(+调度余量)即被切断 → 快速失败
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(7_000);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }, 20_000);

  it('空闲窗大于 handler 时长 → 慢响应完整送达(等慢上游期间不再被杀)', async () => {
    let port = -1;
    const server = serveApp(slowApp(2), { port: 0, idleTimeoutSeconds: 6 }, ({ port: p }) => {
      port = p;
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('slow-2s');
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }, 15_000);

  it('非法值 fail-loud:0 / 超平台上限 255 / 非整数', () => {
    expect(() => serveApp(slowApp(0), { port: 0, idleTimeoutSeconds: 0 })).toThrowError(
      /idleTimeoutSeconds/,
    );
    expect(() => serveApp(slowApp(0), { port: 0, idleTimeoutSeconds: 256 })).toThrowError(
      /idleTimeoutSeconds/,
    );
    expect(() => serveApp(slowApp(0), { port: 0, idleTimeoutSeconds: 1.5 })).toThrowError(
      /idleTimeoutSeconds/,
    );
  });
});
