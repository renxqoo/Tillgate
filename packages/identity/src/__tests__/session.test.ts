import { describe, expect, it } from 'vitest';
import { signSession, verifySession, SESSION_DEFAULT_TTL_S } from '../session.js';
import { SESSION_COOKIE, ADMIN_SESSION_COOKIE } from '../cookies.js';

const SECRET = 'test-jwt-secret-0123456789';

describe('session JWT (jose)', () => {
  it('签发 → 验签成功，载荷字段正确（用户面）', async () => {
    const token = await signSession({ type: 'user', id: 42 }, SECRET);
    const r = await verifySession(token, SECRET, 'user');
    expect(r).toBeDefined();
    expect(r.sub).toBe('42');
    expect(r.type).toBe('user');
    expect(r.iss).toBe('ai-gateway-console');
    expect(r.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.exp).toBeGreaterThan(r.iat);
    expect(r.exp - r.iat).toBe(SESSION_DEFAULT_TTL_S);
  });

  it('签发 → 验签成功，载荷字段正确（管理面）', async () => {
    const token = await signSession({ type: 'admin', id: 42 }, SECRET);
    const r = await verifySession(token, SECRET, 'admin');
    expect(r).toBeDefined();
    expect(r.sub).toBe('42');
    expect(r.type).toBe('admin');
    expect(r.iss).toBe('ai-gateway-admin');
    expect(r.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('默认有效期 24h', () => {
    expect(SESSION_DEFAULT_TTL_S).toBe(24 * 60 * 60);
  });

  it('自定义有效期生效', async () => {
    const token = await signSession({ type: 'user', id: 1, expiresInSeconds: 60 }, SECRET);
    const r = await verifySession(token, SECRET, 'user');
    expect(r.exp - r.iat).toBe(60);
  });

  it('密钥不匹配 → invalid_token', async () => {
    const token = await signSession({ type: 'user', id: 1 }, SECRET);
    await expect(verifySession(token, 'wrong-secret', 'user')).rejects.toMatchObject({ reason: 'invalid_token' });
  });

  it('过期 token → token_expired', async () => {
    const token = await signSession({ type: 'user', id: 1, expiresInSeconds: -10 }, SECRET);
    await expect(verifySession(token, SECRET, 'user')).rejects.toMatchObject({ reason: 'token_expired' });
  });

  it('乱码 → invalid_token', async () => {
    await expect(verifySession('not.a.jwt', SECRET, 'user')).rejects.toMatchObject({ reason: 'invalid_token' });
  });

  it('每次签发 jti 不同', async () => {
    const a = await signSession({ type: 'user', id: 1 }, SECRET);
    const b = await signSession({ type: 'user', id: 1 }, SECRET);
    const ra = await verifySession(a, SECRET, 'user');
    const rb = await verifySession(b, SECRET, 'user');
    expect(ra.jti).not.toBe(rb.jti);
  });

  it('Cookie 名固定（双身份隔离）', () => {
    expect(SESSION_COOKIE).toBe('ag_session');
    expect(ADMIN_SESSION_COOKIE).toBe('ag_admin_session');
    expect(SESSION_COOKIE).not.toBe(ADMIN_SESSION_COOKIE);
  });

  it('身份隔离：用户 token 不能用 admin 类型验签（反之亦然）', async () => {
    const userToken = await signSession({ type: 'user', id: 7 }, SECRET);
    const adminToken = await signSession({ type: 'admin', id: 7 }, SECRET);
    // 用户 token 在 admin 上下文验签 → 拒绝（issuer/type 不符）
    await expect(verifySession(userToken, SECRET, 'admin')).rejects.toMatchObject({ reason: 'invalid_token' });
    // admin token 在 user 上下文验签 → 拒绝
    await expect(verifySession(adminToken, SECRET, 'user')).rejects.toMatchObject({ reason: 'invalid_token' });
    // 同类型同密钥才能验签通过
    await expect(verifySession(userToken, SECRET, 'user')).resolves.toBeDefined();
    await expect(verifySession(adminToken, SECRET, 'admin')).resolves.toBeDefined();
  });
});
