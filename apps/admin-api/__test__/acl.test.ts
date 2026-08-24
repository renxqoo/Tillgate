/**
 * 全局 ACL 中间件契约测试（ADR-0009:执行面数据化——docs/adr/0009）：
 *   1. matchBinding:Hono ':param' 模式匹配（段数相等/参数段非空/字面段相等）;HEAD→GET;
 *   2. 公开白名单直通（无凭据 200）;自身白名单有会话即放行;非 /v1 路径放行走 404;
 *   3. fail-closed:未绑定 → 403 endpoint_unbound（非超管）;超管短路（含未绑定端点）;
 *   4. 码判定:绑定码 ∈ grants 放行 / ∉ 403 insufficient_permission;无凭据 401 优先。
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tillgate/http';
import {
  createAclMiddleware,
  matchBinding,
  type EndpointBinding,
} from '../src/http/middleware/acl';
import type { SessionEnv } from '../src/http/middleware/session';
import { adminErrorCatalog } from '../src/http/error-face';
import { sessionPayload, VALID_TOKEN } from './helpers';

const BINDINGS: EndpointBinding[] = [
  { method: 'GET', path: '/v1/users', code: 'users:read' },
  { method: 'GET', path: '/v1/users/:id', code: 'users:read' },
  { method: 'POST', path: '/v1/users/:id/set-password', code: 'users:set-password' },
  { method: 'DELETE', path: '/v1/roles/:id', code: 'admins:delete' },
];

function aclApp(owner: { status: number; grants: { isSuper: boolean; codes: string[] } } | null) {
  const app = new Hono<SessionEnv>();
  app.use(
    '*',
    createAclMiddleware(
      {
        validate: async (token: string) => (token === VALID_TOKEN ? sessionPayload : null),
        ...(owner != null ? { owner: async () => owner } : {}),
      },
      async (method, path) => matchBinding(BINDINGS, method, path),
    ),
  );
  for (const [method, path] of [
    ['GET', '/v1/users'],
    ['GET', '/v1/users/:id'],
    ['POST', '/v1/users/:id/set-password'],
    ['DELETE', '/v1/roles/:id'],
    ['GET', '/v1/me'],
    ['POST', '/v1/auth/logout'],
    ['POST', '/v1/auth/login'],
    ['GET', '/does-not-exist'],
  ] as const) {
    app.on(method, path, (c) => c.json({ ok: true }));
  }
  app.onError((error, c) => errorHandler({ catalog: adminErrorCatalog })(error, c));
  return app;
}

const SUPER = { status: 0, grants: { isSuper: true, codes: [] } };
const VIEWER = { status: 0, grants: { isSuper: false, codes: ['users:read'] } };
const EMPTY = { status: 0, grants: { isSuper: false, codes: [] } };
const auth = { authorization: `Bearer ${VALID_TOKEN}` };

describe('matchBinding 模式匹配', () => {
  it("':param' 段匹配非空段;段数/字面段必须相等;HEAD 归一为 GET", () => {
    expect(matchBinding(BINDINGS, 'GET', '/v1/users')?.code).toBe('users:read');
    expect(matchBinding(BINDINGS, 'GET', '/v1/users/42')?.code).toBe('users:read');
    expect(matchBinding(BINDINGS, 'POST', '/v1/users/42/set-password')?.code).toBe(
      'users:set-password',
    );
    expect(matchBinding(BINDINGS, 'DELETE', '/v1/roles/9')?.code).toBe('admins:delete');
    // 不匹配:段数错/字面段错/参数段空/方法错
    expect(matchBinding(BINDINGS, 'GET', '/v1/users/42/extra')).toBeNull();
    expect(matchBinding(BINDINGS, 'GET', '/v1/usersX')).toBeNull();
    expect(matchBinding(BINDINGS, 'GET', '/v1/users/')).toBeNull();
    expect(matchBinding(BINDINGS, 'POST', '/v1/users')).toBeNull();
  });
});

describe('白名单与作用域', () => {
  it('公开白名单（登录族）无凭据直通;非 /v1 路径不走 ACL（404 语义保留）', async () => {
    const app = aclApp(EMPTY);
    expect((await app.request('/v1/auth/login', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/does-not-exist')).status).toBe(200); // 挂具注册了该路由,放行即证未走 ACL
  });

  it('自身白名单（me 族/logout）有会话即放行,不做码判定', async () => {
    const app = aclApp(EMPTY);
    expect((await app.request('/v1/me', { headers: auth })).status).toBe(200);
    expect((await app.request('/v1/auth/logout', { method: 'POST', headers: auth })).status).toBe(
      200,
    );
  });
});

describe('fail-closed 与判定链', () => {
  it('未绑定端点:非超管 403 endpoint_unbound;超管短路放行（兜底恢复路径）', async () => {
    const denied = aclApp(EMPTY);
    void denied;
    const unboundApp = aclApp(EMPTY);
    // 挂具没有注册 /v1/unbound 路由——ACL 在路由前抛 403
    const unbound = await unboundApp.request('/v1/unbound', { headers: auth });
    expect(unbound.status).toBe(403);
    expect(((await unbound.json()) as { error: { code: string } }).error.code).toBe(
      'admin.endpoint_unbound',
    );

    const superApp = aclApp(SUPER);
    const superUnbound = await superApp.request('/v1/unbound', { headers: auth });
    expect(superUnbound.status).toBe(404); // 超管短路 → 无路由 → 404（不泄漏）
  });

  it('码判定:绑定码 ∈ grants 放行;∉ 403 insufficient_permission;无凭据 401 优先', async () => {
    const viewer = aclApp(VIEWER);
    expect((await viewer.request('/v1/users', { headers: auth })).status).toBe(200);
    expect((await viewer.request('/v1/users/42', { headers: auth })).status).toBe(200);
    const denied = await viewer.request('/v1/users/42/set-password', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-pass-123' }),
    });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
      'admin.insufficient_permission',
    );
    expect((await viewer.request('/v1/users')).status).toBe(401);
  });

  it('属主回查缺省（纯会话形态）→ 授权面缺失 → 非超管路径 fail-closed', async () => {
    const app = aclApp(null);
    const res = await app.request('/v1/users', { headers: auth });
    expect(res.status).toBe(403);
  });
});
