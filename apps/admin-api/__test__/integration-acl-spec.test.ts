/**
 * 安全审查规格（子代理 D——ACL 绑定与 :key 路径参数匹配）：
 * 直接解析迁移 0086 的 endpoint_permissions 种子（与生产同源），配合 acl 中间件
 * 验证 GET/PUT 集成设置端点的 fail-closed 语义与权限码判定。
 * 断言「当前实际行为」以证实/排除审查发现，不构成新契约。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '@tillgate/http';

import type { SessionEnv } from '../src/http/middleware/session';
import { createAclMiddleware, matchBinding } from '../src/http/middleware/acl';
import { ADMIN_FACE_OVERRIDES, adminErrorCatalog } from '../src/http/error-face';
import { ADMIN_ID } from './helpers';

/** 迁移 0086 endpoint_permissions 种子（method, path, code）——从 SQL 文本解析 */
function seedBindings(): Array<{ method: string; path: string; code: string }> {
  const sql = readFileSync(
    join(import.meta.dirname, '../../../packages/db/migrations/0086_integration_settings.sql'),
    'utf8',
  );
  const tuples = [
    ...sql.matchAll(
      /\('(\w+)',\s*'([^']+)',\s*\(SELECT id FROM permissions WHERE code = '([^']+)'/g,
    ),
  ].map((m) => ({
    method: m[1] ?? '',
    path: m[2] ?? '',
    code: m[3] ?? '',
  }));
  // 0087 绑定改挂：PUT /v1/settings/integrations/:key → settings:integrations（权限拆分）
  const sql87 = readFileSync(
    join(
      import.meta.dirname,
      '../../../packages/db/migrations/0087_settings_integrations_permission.sql',
    ),
    'utf8',
  );
  if (sql87.includes("ep.method = 'PUT' AND ep.path = '/v1/settings/integrations/:key'")) {
    for (const tuple of tuples) {
      if (tuple.method === 'PUT' && tuple.path === '/v1/settings/integrations/:key') {
        tuple.code = 'settings:integrations';
      }
    }
  }
  return tuples;
}

/** 非超管会话挂具：令牌 'tok' → 指定权限码（isSuper=false） */
function appWithGrants(codes: string[], isSuper = false): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  app.use(
    '*',
    createAclMiddleware(
      {
        validate: async (token: string) =>
          token === 'tok'
            ? {
                realm: 'admin',
                sub: String(ADMIN_ID),
                jti: 'j',
                iss: 'i',
                exp: Math.floor(Date.now() / 1000) + 3600,
                iat: 1,
              }
            : null,
        owner: async () => ({ status: 0, grants: { isSuper, codes } }),
      },
      async (method, path) => matchBinding(seedBindings(), method, path),
    ),
  );
  // 目标路由形状与 settings.ts 相同（本测试只验 ACL 面，不触 control-plane）
  app.get('/v1/settings/integrations', (c) => c.json({ ok: true }));
  app.put('/v1/settings/integrations/:key', (c) => c.json({ ok: true, key: c.req.param('key') }));
  app.post('/v1/settings/integrations/:key', (c) => c.json({ ok: true }));
  // 错误面与 createAdminApp 同装配（ACL 拒绝错误需要目录渲染才能出 403 信封）
  app.onError((error, c) =>
    errorHandler({ catalog: adminErrorCatalog, overrides: ADMIN_FACE_OVERRIDES })(error, c),
  );
  return app;
}

const AUTH = { authorization: 'Bearer tok' };
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };

describe('规格 D-6：迁移 0086 ACL 种子与实际路由的匹配面', () => {
  it('种子恰为 GET=settings:read / PUT=settings:integrations 两条（0087 拆分后）', () => {
    expect(seedBindings()).toEqual([
      { method: 'GET', path: '/v1/settings/integrations', code: 'settings:read' },
      { method: 'PUT', path: '/v1/settings/integrations/:key', code: 'settings:integrations' },
    ]);
  });

  it('GET：持 settings:read 放行；无码 403 insufficient_permission', async () => {
    expect(
      (
        await appWithGrants(['settings:read']).request('/v1/settings/integrations', {
          headers: AUTH,
        })
      ).status,
    ).toBe(200);
    const denied = await appWithGrants(['settings:update']).request('/v1/settings/integrations', {
      headers: AUTH,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'admin.insufficient_permission' } });
  });

  it('PUT :key：含点号的真实 key（payment.stripe）命中 :param 段匹配；只读码 403', async () => {
    const ok = await appWithGrants(['settings:integrations']).request(
      '/v1/settings/integrations/payment.stripe',
      { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) },
    );
    expect(ok.status).toBe(200);
    const denied = await appWithGrants(['settings:read']).request(
      '/v1/settings/integrations/payment.stripe',
      { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) },
    );
    expect(denied.status).toBe(403);
    // 权限拆分（0087）：仅持旧码 settings:update 不再放行集成写入
    const legacyOnly = await appWithGrants(['settings:update']).request(
      '/v1/settings/integrations/payment.stripe',
      { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) },
    );
    expect(legacyOnly.status).toBe(403);
  });

  it('未绑定方法（POST）fail-closed 403 endpoint_unbound（超管例外直通）', async () => {
    const app = appWithGrants(['settings:update']);
    const unbound = await app.request('/v1/settings/integrations/smtp', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toMatchObject({ error: { code: 'admin.endpoint_unbound' } });

    const superAdmin = await appWithGrants([], true).request('/v1/settings/integrations/smtp', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(superAdmin.status).toBe(200);
  });

  it('路径段为空（PUT /v1/settings/integrations/）不命中 :key 绑定 → fail-closed', async () => {
    const res = await appWithGrants(['settings:update']).request('/v1/settings/integrations/', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});
