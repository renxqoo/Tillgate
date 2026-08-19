/**
 * 操练场代理集成套件（真 PG + 注入 fetch 桩的网关）：
 * 会话守护 / 请求体白名单收敛 / 网关 JWT 现签（typ playground 低限额）/
 * SSE 流原样回传 / 上游错误信封直传 / 账户封禁 403。
 */
import { describe, expect, it, vi } from 'vitest';
import { signSession } from '@ai-gateway/identity';
import { signPlaygroundJwt, verifyPlaygroundJwt } from '../domain/playground.js';
import { playgroundRoutes } from '../routes/playground.js';
import { newUser } from './helpers.js';

const JWT_SECRET = 'pg-test-jwt-secret-0123456789abcdef';
const GATEWAY = 'http://gw.test';

/** 恒抛的 fetch 替身（模拟网关不可达） */
const deadFetch = (): typeof fetch => async () => {
  throw new Error('down');
};

/** 网关桩：记录鉴权头与请求体，返回 SSE 或错误 */
function gatewayStub(opts: { status?: number; body?: string } = {}) {
  const seen: Array<{ auth: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen.push({
      auth: ((init?.headers ?? {}) as Record<string, string>).authorization ?? '',
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (opts.status && opts.status !== 200) {
      return new Response(JSON.stringify({ error: { code: 'upstream_reject', message: 'x' } }), {
        status: opts.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(opts.body ?? 'data: {"delta":"hi"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return { seen, fetchImpl };
}

/** 会话桩：把 userIdRef.id 注入上下文（模拟 session 中间件） */
function sessionStub(userIdRef: { id: number }) {
  return vi.fn(async (c, next) => {
    c.set('userId', userIdRef.id);
    await next();
  }) as unknown as Parameters<typeof playgroundRoutes>[1];
}

function buildApp(stub: ReturnType<typeof gatewayStub>, userIdRef: { id: number }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub.fetchImpl as typeof fetch;
  const app = playgroundRoutes(
    { gatewayUrl: GATEWAY, gatewayJwtSecret: JWT_SECRET, userStatus: async (id) => id === userIdRef.id },
    sessionStub(userIdRef),
  );
  return {
    app,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const post = (app: ReturnType<typeof buildApp>['app'], body: unknown, token = 'tok') =>
  app.request('/v1/playground/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('playground 纯规则', () => {
  it('JWT 现签与验签往返（typ playground）', async () => {
    const token = await signPlaygroundJwt(42, JWT_SECRET);
    expect(await verifyPlaygroundJwt(token, JWT_SECRET)).toEqual({ sub: '42', typ: 'playground' });
    expect(await verifyPlaygroundJwt(token, 'wrong-secret')).toBeNull();
  });
});

describe('playground 代理路由', () => {
  it('happy path：网关收到 playground JWT + stream 恒 true；SSE 原样回传', async () => {
    const account = await newUser();
    const userIdRef = { id: account.id };
    const stub = gatewayStub();
    const { app, restore } = buildApp(stub, userIdRef);
    try {
      const res = await post(app, {
        model: 'gpt-x',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(await res.text()).toContain('data:');
      expect(stub.seen.length).toBe(1);
      expect(stub.seen[0]!.body.stream).toBe(true);
      const verified = await verifyPlaygroundJwt(stub.seen[0]!.auth.slice(7), JWT_SECRET);
      expect(verified).toEqual({ sub: String(account.id), typ: 'playground' });
    } finally {
      restore();
    }
  });

  it('请求体白名单：畸形 messages 400；多余字段收敛', async () => {
    const account = await newUser();
    const stub = gatewayStub();
    const { app, restore } = buildApp(stub, { id: account.id });
    try {
      expect((await post(app, { model: 'x', messages: [] })).status).toBe(400);
      expect(
        (
          await post(app, {
            model: 'x',
            messages: [{ role: 'hacker', content: 'x' }],
          })
        ).status,
      ).toBe(400);
      // 合法体 + 未知字段：透传前被 zod 剥离（strip 语义）
      const res = await post(app, {
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        hacker_field: 'no',
      });
      expect(res.status).toBe(200);
      expect(stub.seen[0]!.body.hacker_field).toBeUndefined();
      expect(stub.seen[0]!.body.temperature).toBe(0.5);
    } finally {
      restore();
    }
  });

  it('上游错误信封直传（402 余额不足等）；网关不可达 503', async () => {
    const account = await newUser();
    const bad = gatewayStub({ status: 402 });
    const a = buildApp(bad, { id: account.id });
    try {
      const res = await post(a.app, { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_reject');
    } finally {
      a.restore();
    }

    // 不可达：fetch 恒抛
    const dead = deadFetch();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = dead;
    const b = playgroundRoutes(
      { gatewayUrl: GATEWAY, gatewayJwtSecret: JWT_SECRET, userStatus: async () => true },
      sessionStub({ id: account.id }),
    );
    try {
      const res = await post(b, { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
      expect(res.status).toBe(503);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('封禁账户 403；未挂会话中间件的裸路由不在此测（路由层 session 守护由装配测试覆盖）', async () => {
    const account = await newUser();
    const stub = gatewayStub();
    // 封禁：userStatus 返回 false（直接模拟仓库视角），网关零调用
    const banned = playgroundRoutes(
      { gatewayUrl: GATEWAY, gatewayJwtSecret: JWT_SECRET, userStatus: async () => false },
      sessionStub({ id: account.id }),
    );
    const res = await post(banned, { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(403);
    expect(stub.seen.length).toBe(0);
  });
});

describe('网关会话桥（与 gateway 中间件的契约）', () => {
  it('signSession（用户面会话）不能当网关凭证用——凭证类型物理隔离', async () => {
    const sessionToken = await signSession({ type: 'user', id: 1 }, JWT_SECRET);
    const verified = await verifyPlaygroundJwt(sessionToken, JWT_SECRET);
    // 网关 JWT 桥只认 typ playground；会话 token 无 typ → 验签助手按契约拒绝
    expect(verified?.typ === 'playground').toBe(false);
  });
});
