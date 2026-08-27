/**
 * 停机编排绑定测试（drain 顺序契约归 runtime 包；此处锁 gateway 形状绑定）+
 * otel 中间件 no-op 安全性（off 模式不破坏请求链）。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createGatewayShutdown } from '../src/shutdown';
import { otelMiddleware } from '../src/http/middleware/otel';
import type { AuthEnv } from '../src/http/middleware/api-key';

describe('createGatewayShutdown（gateway 绑定形状）', () => {
  it('宽限耗尽透传 drain 钩子（server_draining 生产者的停机侧接线）', async () => {
    const order: string[] = [];
    const shutdown = createGatewayShutdown({
      server: { close: () => {} } as never, // 不回调 = 在途未完成 → 宽限路径
      otel: { shutdown: async () => {} },
      redis: null as never,
      closeDb: async () => {},
      inference: { close: () => {} },
      settleWake: { close: async () => {} },
      graceMs: 100, // 下界钳到 1s——宽限耗尽走 drain 路径
      drain: {
        abort: () => {
          order.push('drain-abort');
        },
        finalizeMs: 1_000,
      },
      exit: ((code: number) => {
        order.push(`exit:${code}`);
        return undefined as never;
      }) as never,
    });
    shutdown('SIGTERM');
    // 宽限下界 1s：drain abort 先于强退
    await new Promise((r) => {
      setTimeout(r, 1_200);
    });
    expect(order).toEqual(['drain-abort']);
    await new Promise((r) => {
      setTimeout(r, 1_100);
    });
    expect(order).toEqual(['drain-abort', 'exit:1']);
  });

  it('触发一次：otel → closeables（inference 退订、settle-wake）→ redis → db；二次幂等', async () => {
    const order: string[] = [];
    const shutdown = createGatewayShutdown({
      // runtime 契约：close(callback)——回调内继续收口链
      server: {
        close: (cb: () => void) => {
          order.push('server');
          cb();
        },
      } as never,
      otel: {
        shutdown: async () => {
          order.push('otel');
        },
      },
      redis: {
        quit: async () => {
          order.push('redis');
        },
      } as never,
      closeDb: async () => {
        order.push('db');
      },
      inference: {
        close: () => {
          order.push('inference');
        },
      },
      settleWake: {
        close: async () => {
          order.push('settle-wake');
        },
      },
      graceMs: 60_000,
      exit: ((code: number) => {
        order.push(`exit:${code}`);
        return undefined as never;
      }) as never,
    });
    shutdown('SIGTERM');
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    expect(order).toEqual(['server', 'otel', 'inference', 'settle-wake', 'redis', 'db', 'exit:0']);
    shutdown('SIGINT'); // 二次信号不重复触发
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    expect(order.filter((x) => x === 'exit:0')).toHaveLength(1);
  });
});

describe('otelMiddleware（off 模式 no-op）', () => {
  it('logger 注入分支：drain 日志走注入出口', async () => {
    const order: string[] = [];
    const shutdown = createGatewayShutdown({
      server: { close: (cb: () => void) => cb() } as never,
      otel: { shutdown: async () => {} },
      redis: { quit: async () => {} } as never,
      closeDb: async () => {},
      inference: { close: () => {} },
      settleWake: { close: async () => {} },
      graceMs: 60_000,
      exit: (() => {}) as never,
      logger: {
        info: (_o, msg) => order.push(msg),
        error: (_o, msg) => order.push(msg),
      },
    });
    shutdown('SIGTERM');
    await new Promise((r) => {
      setTimeout(r, 30);
    });
    expect(order.some((m) => m.includes('draining') || m.includes('drained'))).toBe(true);
  });

  it('请求链不破坏；探针路径直通', async () => {
    const app = new Hono<AuthEnv>();
    app.use('*', otelMiddleware());
    app.get('/healthz', (c) => c.json({ ok: true }));
    app.get('/v1/x', (c) => c.json({ ok: true }));
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/v1/x')).status).toBe(200);
  });
});
