/**
 * E2E ④跨 app 生效链（admin 管用户 → client 即时感知，双真进程共库）：
 *   - 管理员重置用户密码 → client 旧 token 401（R5-2）+ 新密码可登
 *   - 管理员封禁用户 → client 既有 token 即刻 401
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupE2E,
  e2eDb,
  e2eUid,
  http,
  loginAdmin,
  seedAdmin,
  startAdminApi,
  trackE2E,
  type E2EAdminApi,
} from './e2e-kit.js';
import { startClientApi, type E2EClientApi } from '../../../client-api-v2/src/__tests__/e2e-kit.js';

let admin: E2EAdminApi;
let client: E2EClientApi;
let token: string;

beforeAll(async () => {
  const db = e2eDb();
  admin = await startAdminApi(db);
  client = await startClientApi(db);
  const { email, password } = await seedAdmin(db);
  token = await loginAdmin(admin.baseUrl, email, password);
});

afterAll(async () => {
  await admin.stop();
  await client.stop();
  await cleanupE2E(admin.db);
});

describe('E2E 跨 app：管理动作 → 用户面即时生效', () => {
  it('管理员重置密码 → client 旧 token 失效 + 新密码可登', async () => {
    const email = `${e2eUid('x')}@example.com`;
    const reg = await http(client.baseUrl, '/v1/auth/register', {
      body: { email, password: 'cross-app-pass-1' },
    });
    expect(reg.status).toBe(201);
    const userToken = reg.body.token as string;
    const userId = reg.body.userId as number;
    trackE2E.user(userId);
    expect((await http(client.baseUrl, '/v1/me', { token: userToken })).status).toBe(200);

    // 管理面重置密码（全网会话下线）
    const reset = await http(admin.baseUrl, `/v1/users/${userId}/set-password`, {
      token,
      body: { password: 'reset-by-admin-1' },
    });
    expect(reset.status).toBe(200);

    // 用户面：旧 token 401；旧密码死；新密码可登
    expect((await http(client.baseUrl, '/v1/me', { token: userToken })).status).toBe(401);
    expect(
      (await http(client.baseUrl, '/v1/auth/login', { body: { email, password: 'cross-app-pass-1' } })).status,
    ).toBe(401);
    const reLogin = await http(client.baseUrl, '/v1/auth/login', {
      body: { email, password: 'reset-by-admin-1' },
    });
    expect(reLogin.status).toBe(200);
  });

  it('管理员封禁 → client 既有 token 即刻 401', async () => {
    const email = `${e2eUid('x')}@example.com`;
    const reg = await http(client.baseUrl, '/v1/auth/register', {
      body: { email, password: 'cross-app-pass-1' },
    });
    const userToken = reg.body.token as string;
    const userId = reg.body.userId as number;
    trackE2E.user(userId);
    expect((await http(client.baseUrl, '/v1/me', { token: userToken })).status).toBe(200);

    const ban = await http(admin.baseUrl, `/v1/users/${userId}`, {
      method: 'PATCH',
      token,
      body: { status: 1 },
    });
    expect(ban.status).toBe(200);
    expect((await http(client.baseUrl, '/v1/me', { token: userToken })).status).toBe(401);
  });
});
