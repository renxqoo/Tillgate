import { describe, expect, it } from 'vitest';
import { signSession, verifySession, SESSION_COOKIE, SESSION_DEFAULT_TTL_S } from './session.js';

const SECRET = 'test-jwt-secret-0123456789';

describe('session JWT (jose)', () => {
  it('签发 → 验签成功，载荷字段正确', async () => {
    const token = await signSession({ userId: 42, role: 1 }, SECRET);
    const r = await verifySession(token, SECRET);
    expect(r.ok).toBe(true);
    expect(r.payload).toBeDefined();
    expect(r.payload!.sub).toBe('42');
    expect(r.payload!.role).toBe(1);
    expect(r.payload!.iss).toBe('ai-gateway-console');
    expect(r.payload!.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.payload!.exp).toBeGreaterThan(r.payload!.iat);
    expect(r.payload!.exp - r.payload!.iat).toBe(SESSION_DEFAULT_TTL_S);
  });

  it('默认有效期 24h', () => {
    expect(SESSION_DEFAULT_TTL_S).toBe(24 * 60 * 60);
  });

  it('自定义有效期生效', async () => {
    const token = await signSession({ userId: 1, role: 0, expiresInSeconds: 60 }, SECRET);
    const r = await verifySession(token, SECRET);
    expect(r.ok).toBe(true);
    expect(r.payload!.exp - r.payload!.iat).toBe(60);
  });

  it('密钥不匹配 → invalid_token', async () => {
    const token = await signSession({ userId: 1, role: 0 }, SECRET);
    const r = await verifySession(token, 'wrong-secret');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_token');
  });

  it('过期 token → token_expired', async () => {
    const token = await signSession({ userId: 1, role: 0, expiresInSeconds: -10 }, SECRET);
    const r = await verifySession(token, SECRET);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('token_expired');
  });

  it('乱码 → invalid_token', async () => {
    const r = await verifySession('not.a.jwt', SECRET);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_token');
  });

  it('每次签发 jti 不同', async () => {
    const a = await signSession({ userId: 1, role: 0 }, SECRET);
    const b = await signSession({ userId: 1, role: 0 }, SECRET);
    const ra = await verifySession(a, SECRET);
    const rb = await verifySession(b, SECRET);
    expect(ra.payload!.jti).not.toBe(rb.payload!.jti);
  });

  it('Cookie 名固定', () => {
    expect(SESSION_COOKIE).toBe('ag_session');
  });

  it('role 注入：普通用户 role=0', async () => {
    const token = await signSession({ userId: 7, role: 0 }, SECRET);
    const r = await verifySession(token, SECRET);
    expect(r.payload!.role).toBe(0);
  });
});
