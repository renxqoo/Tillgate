/**
 * RBAC 权限守卫契约测试（docs/admin-rbac/DESIGN §2.3）：
 *   1. 方法分派表驱动:GET/HEAD → domain:read,POST/PUT/PATCH/DELETE → domain:write;
 *   2. 会话 → 守卫组合链:401（无/坏凭据）优先于 403;授权放行注入 adminRole;
 *   3. fail-closed:属主回查缺省（纯会话校验形态）→ adminRole 缺失 → 403;
 *   4. 403 语义:insufficient_permission 不泄漏角色事实。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { errorHandler } from '@tokenlens/http';
import {
  sessionMiddleware,
  type SessionEnv,
  type SessionValidator,
} from '../src/http/middleware/session';
import { domainGuard, requirePermission } from '../src/http/middleware/permission';
import { adminErrorCatalog } from '../src/http/error-face';
import { sessionPayload, VALID_TOKEN } from './helpers';

function validatorWith(owner?: SessionValidator['owner']): SessionValidator {
  return {
    validate: async (token: string) => (token === VALID_TOKEN ? sessionPayload : null),
    ...(owner != null ? { owner } : {}),
  };
}

/** session + 域守卫组合的探针 app（全方法注册,回显 adminRole） */
function probeApp(domain: 'users' | 'funds', owner?: SessionValidator['owner']) {
  const session = sessionMiddleware(validatorWith(owner));
  const app = new Hono<SessionEnv>();
  const guard = domainGuard(domain, session);
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    app[method]('/probe', guard, (c) => c.json({ ok: true, role: c.get('adminRole') }));
  }
  app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
  return app;
}

describe('domainGuard 方法分派（表驱动——GET/HEAD 读,其余写）', () => {
  const cases = [
    { method: 'GET', role: 'viewer' as const, domain: 'users' as const, status: 200 },
    { method: 'HEAD', role: 'viewer' as const, domain: 'users' as const, status: 200 },
    { method: 'POST', role: 'viewer' as const, domain: 'users' as const, status: 403 },
    { method: 'PUT', role: 'viewer' as const, domain: 'funds' as const, status: 403 },
    { method: 'PATCH', role: 'viewer' as const, domain: 'funds' as const, status: 403 },
    { method: 'DELETE', role: 'viewer' as const, domain: 'funds' as const, status: 403 },
    // finance 有 funds:write 无 users:write——读写分派逐域生效
    { method: 'GET', role: 'finance' as const, domain: 'funds' as const, status: 200 },
    { method: 'POST', role: 'finance' as const, domain: 'funds' as const, status: 200 },
    { method: 'POST', role: 'finance' as const, domain: 'users' as const, status: 403 },
    // super_admin 全放行
    { method: 'POST', role: 'super_admin' as const, domain: 'funds' as const, status: 200 },
  ];

  it.each(cases)('$method $domain@$role → $status', async ({ method, role, domain, status }) => {
    const app = probeApp(domain, async () => ({ status: 0, role }));
    const res = await app.request('/probe', {
      method,
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(status);
  });
});

describe('会话 → 守卫组合链（顺序语义）', () => {
  it('无凭据 401 优先于权限判定（守卫在 session 之后）', async () => {
    const app = probeApp('users', async () => ({ status: 0, role: 'super_admin' }));
    const none = await app.request('/probe', { method: 'GET' });
    expect(none.status).toBe(401);
    const bad = await app.request('/probe', {
      method: 'GET',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(bad.status).toBe(401);
  });

  it('授权放行:adminRole 已注入（属主回查搭载）;封禁属主 401', async () => {
    const app = probeApp('users', async () => ({ status: 0, role: 'operator' }));
    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'operator' });

    const banned = probeApp('users', async () => ({ status: 1, role: 'operator' }));
    expect(
      (await banned.request('/probe', { headers: { authorization: `Bearer ${VALID_TOKEN}` } }))
        .status,
    ).toBe(401);
  });

  it('fail-closed:属主回查缺省（纯会话校验形态）→ adminRole 缺失 → 403', async () => {
    const app = probeApp('users');
    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('admin.insufficient_permission');
  });

  it('403 语义:统一 insufficient_permission,上下文只带所需权限（不泄漏角色）', async () => {
    const app = probeApp('funds', async () => ({ status: 0, role: 'support' }));
    const res = await app.request('/probe', {
      method: 'POST',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; context?: unknown } };
    expect(body.error.code).toBe('admin.insufficient_permission');
    expect(JSON.stringify(body)).not.toContain('support');
  });
});

/** requirePermission 直挂探针（不捕获外层变量——模块级） */
const singleApp = (permission: string, role: string): Hono<SessionEnv> => {
  const app = new Hono<SessionEnv>();
  const chain: MiddlewareHandler<SessionEnv> = async (c, next) => {
    c.set('adminRole', role);
    await next();
  };
  app.use('/x', chain);
  app.get('/x', requirePermission(permission), (c) => c.json({ ok: true }));
  app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
  return app;
};

describe('requirePermission（单权限守卫直挂形态）', () => {
  it('授权/拒绝/未知权限串拒绝', async () => {
    expect((await singleApp('settings:read', 'viewer').request('/x')).status).toBe(200);
    expect((await singleApp('settings:write', 'viewer').request('/x')).status).toBe(403);
    expect((await singleApp('nonsense:read', 'super_admin').request('/x')).status).toBe(403);
  });
});
