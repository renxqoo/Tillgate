/**
 * ./next session 行为规格(mock next/headers)。
 * SESSION_TTL_S 与 secure 在模块加载期求值,覆盖/缺省两态用 resetModules + 动态导入分离。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { jar } = vi.hoisted(() => ({
  jar: { get: vi.fn(), set: vi.fn(), has: vi.fn(), delete: vi.fn() },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => jar),
  headers: vi.fn(async () => new Headers()),
}));

import {
  ADMIN_SESSION_COOKIE,
  SESSION_COOKIE,
  clearAdminSessionCookie,
  clearSessionCookie,
  getAdminSessionToken,
  getSessionToken,
  hasAdminSessionCookie,
  hasSessionCookie,
  setSessionToken,
} from '../src/next/session';

const originalEnv = process.env.NODE_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SESSION_TTL_SECONDS;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('cookie 名词表(保持存量会话兼容)', () => {
  it('用户面 ag_session / 管理面 ag_admin_session', () => {
    expect(SESSION_COOKIE).toBe('ag_session');
    expect(ADMIN_SESSION_COOKIE).toBe('ag_admin_session');
  });
});

describe('读 token(cookie 值即 JWT;无会话 null)', () => {
  it('getSessionToken / getAdminSessionToken 各读自己的 cookie', async () => {
    jar.get.mockImplementation((name: string) =>
      name === SESSION_COOKIE ? { value: 'user-jwt' } : undefined,
    );
    await expect(getSessionToken()).resolves.toBe('user-jwt');
    await expect(getAdminSessionToken()).resolves.toBeNull();

    jar.get.mockImplementation((name: string) =>
      name === ADMIN_SESSION_COOKIE ? { value: 'admin-jwt' } : undefined,
    );
    await expect(getAdminSessionToken()).resolves.toBe('admin-jwt');
    await expect(getSessionToken()).resolves.toBeNull();
  });
});

describe('写会话(HttpOnly + lax + path=/;secure 随 NODE_ENV;maxAge 随 SESSION_TTL_SECONDS)', () => {
  it('缺省 TTL 86400、非 production 不加 secure', async () => {
    await setSessionToken('t1');
    expect(jar.set).toHaveBeenCalledWith(SESSION_COOKIE, 't1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 86_400,
    });
  });

  it('SESSION_TTL_SECONDS 覆盖 TTL(模块加载期读取)', async () => {
    process.env.SESSION_TTL_SECONDS = '60';
    vi.resetModules();
    const mod = await import('../src/next/session');
    await mod.setAdminSessionToken('t2');
    expect(jar.set).toHaveBeenLastCalledWith(ADMIN_SESSION_COOKIE, 't2', {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 60,
    });
  });

  it('production 环境加 secure', async () => {
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const mod = await import('../src/next/session');
    await mod.setSessionToken('t3');
    expect(jar.set).toHaveBeenLastCalledWith(SESSION_COOKIE, 't3', {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 86_400,
    });
  });
});

describe('has / clear(Bearer 无服务端态——清本地即下线)', () => {
  it('has 双面各查自己的 cookie;clear 各删自己的 cookie', async () => {
    jar.has.mockImplementation((name: string) => name === SESSION_COOKIE);
    await expect(hasSessionCookie()).resolves.toBe(true);
    await expect(hasAdminSessionCookie()).resolves.toBe(false);

    await clearSessionCookie();
    await clearAdminSessionCookie();
    expect(jar.delete).toHaveBeenNthCalledWith(1, SESSION_COOKIE);
    expect(jar.delete).toHaveBeenNthCalledWith(2, ADMIN_SESSION_COOKIE);
  });
});
