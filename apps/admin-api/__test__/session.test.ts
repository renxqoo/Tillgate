import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../src/app';
import { fakeDeps } from './helpers';

/**
 * 会话中间件契约:Bearer 缺失/无效 → 401
 * 统一口径(不区分原因);有效 admin realm 会话放行;探针豁免。
 */

describe('admin 会话鉴权', () => {
  it('无 Authorization → 401 http.unauthorized', async () => {
    const app = createAdminApp(fakeDeps({}));
    const res = await app.request('/v1/users');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: 'http.unauthorized', message: 'Missing or invalid bearer credentials' },
    });
  });

  it('非 Bearer 形态 / 错误令牌 → 401 统一口径(不泄漏管理账号状态)', async () => {
    const app = createAdminApp(fakeDeps({}));
    const basic = await app.request('/v1/users', { headers: { authorization: 'Basic abc' } });
    expect(basic.status).toBe(401);
    const bad = await app.request('/v1/users', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: { code: 'http.unauthorized' } });
  });

  it('有效会话放行到路由(fake facade 空页 200)', async () => {
    const app = createAdminApp(fakeDeps({}));
    const res = await app.request('/v1/users', {
      headers: { authorization: 'Bearer admin-session-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [], total: 0, page: 1, pageSize: 20 });
  });

  it('sub 非正整数(令牌损毁)→ 401', async () => {
    // sessions 替身返回异常 sub
    const deps = fakeDeps({});
    (deps.sessions as { validate: (t: string) => Promise<unknown> }).validate = async () => ({
      realm: 'admin',
      sub: 'not-a-number',
      jti: 'j',
      iss: 'tillgate:admin',
      exp: 9999999999,
      iat: 1,
    });
    const patched = createAdminApp(deps);
    const res = await patched.request('/v1/users', {
      headers: { authorization: 'Bearer admin-session-token' },
    });
    expect(res.status).toBe(401);
  });
});
