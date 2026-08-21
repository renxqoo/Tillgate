/**
 * E2E ①管理员登录全链（真进程 + 真 DB + 真 scrypt）：
 * 种子管理员 → HTTP 登录（错密 401 / 对密 200 发 Bearer）→ me →
 * 改密（旧 token 全网即刻失效）→ 旧密码死亡 → 新密码重登。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupE2E,
  e2eDb,
  http,
  loginAdmin,
  seedAdmin,
  startAdminApi,
  type E2EAdminApi,
} from './e2e-kit.js';

let api: E2EAdminApi;
let email: string;
let password: string;

beforeAll(async () => {
  const db = e2eDb();
  api = await startAdminApi(db);
  ({ email, password } = await seedAdmin(db));
});

afterAll(async () => {
  await api.stop();
  await cleanupE2E(api.db);
});

describe('E2E 管理员登录全链', () => {
  it('healthz 200（真进程真 DB）', async () => {
    const res = await http(api.baseUrl, '/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('错密 401；对密 200 发 Bearer；me 回显', async () => {
    const bad = await http(api.baseUrl, '/v1/auth/login', { body: { email, password: 'wrong-password' } });
    expect(bad.status).toBe(401);

    const ok = await http(api.baseUrl, '/v1/auth/login', { body: { email, password } });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe('string');

    const me = await http(api.baseUrl, '/v1/me', { token: ok.body.token as string });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it('改密：旧 token 即刻失效（R5-2）；新密码重登可用', async () => {
    const first = await loginAdmin(api.baseUrl, email, password);
    const changed = await http(api.baseUrl, '/v1/me/password', {
      token: first,
      body: { oldPassword: password, newPassword: 'fresh-e2e-password-1' },
    });
    expect(changed.status).toBe(200);
    const renewed = changed.body.token as string;

    // 旧 token：失效线之前 → 401；新 token → 200
    expect((await http(api.baseUrl, '/v1/me', { token: first })).status).toBe(401);
    expect((await http(api.baseUrl, '/v1/me', { token: renewed })).status).toBe(200);

    // 旧密码死亡 / 新密码可登
    expect((await http(api.baseUrl, '/v1/auth/login', { body: { email, password } })).status).toBe(401);
    expect((await http(api.baseUrl, '/v1/auth/login', { body: { email, password: 'fresh-e2e-password-1' } })).status).toBe(200);
  });

  it('无凭证访问管理面 → 401（fail-closed 默认）', async () => {
    expect((await http(api.baseUrl, '/v1/users')).status).toBe(401);
    expect((await http(api.baseUrl, '/v1/channel-funds')).status).toBe(401);
  });
});
