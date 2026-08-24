/**
 * 会话与吊销测试(v1 session.test + revocation.test 迁移):载荷契约、跨 realm
 * 互验拒绝、validate 链(jti/锚点)、logout、GREATEST 单调、realm 白名单双路径
 * (B08 回归)。
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../src/testing/harness.js';

const harness = () => createTestHarness();

describe('sessions.sign / verify(载荷契约与双 realm 隔离)', () => {
  it('签发-验签往返:realm/sub/jti/iss/exp-iat=TTL;iatMs 毫秒', async () => {
    const h = harness();
    const token = await h.api.sessions.sign({ realm: 'user', subjectId: 42 });
    const payload = await h.api.sessions.verify(token, 'user');
    expect(payload.realm).toBe('user');
    expect(payload.sub).toBe('42');
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.iss).toBe('tillgate-console');
    expect(payload.exp - payload.iat).toBe(86_400);
    expect(payload.iatMs).toBe(h.ctx.clock.now().getTime());
  });

  it('jti 每次不同;自定义 TTL 生效且界校验', async () => {
    const h = harness();
    const a = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    const b = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    expect((await h.api.sessions.verify(a, 'user')).jti).not.toBe(
      (await h.api.sessions.verify(b, 'user')).jti,
    );
    const custom = await h.api.sessions.sign({ realm: 'user', subjectId: 1, ttlSec: 120 });
    expect((await h.api.sessions.verify(custom, 'user')).exp).toBe(
      (await h.api.sessions.verify(a, 'user')).iat + 120,
    );
    await expect(
      h.api.sessions.sign({ realm: 'user', subjectId: 1, ttlSec: 1 }),
    ).rejects.toMatchObject({
      code: 'identity.invalid_input',
    });
  });

  it('跨 realm 互验拒绝(user ↔ admin,即使密钥巧合相同)', async () => {
    const h = harness();
    const userToken = await h.api.sessions.sign({ realm: 'user', subjectId: 7 });
    const adminToken = await h.api.sessions.sign({ realm: 'admin', subjectId: 7 });
    await expect(h.api.sessions.verify(userToken, 'admin')).rejects.toMatchObject({
      code: 'identity.invalid_token',
      context: { reason: 'invalid_token' },
    });
    await expect(h.api.sessions.verify(adminToken, 'user')).rejects.toMatchObject({
      code: 'identity.invalid_token',
    });
    // 同 numeric id 不串号:admin 7 与 user 7 互不干扰(realm 隔离)
    const adminPayload = await h.api.sessions.verify(adminToken, 'admin');
    expect(adminPayload.realm).toBe('admin');
  });

  it('错密钥签名 → invalid_token;过期 → token_expired;乱码 → invalid_token', async () => {
    const h = harness();
    const token = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    // 用 admin 密钥签不出 user token(密钥独立);用 jose 直接构造错密钥令牌
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ realm: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('tillgate-console')
      .setSubject('1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('wrong-secret-wrong-secret-wrong'));
    await expect(h.api.sessions.verify(forged, 'user')).rejects.toMatchObject({
      code: 'identity.invalid_token',
    });

    h.advanceClockMs(86_401_000);
    await expect(h.api.sessions.verify(token, 'user')).rejects.toMatchObject({
      code: 'identity.invalid_token',
      context: { reason: 'token_expired' },
    });
    await expect(h.api.sessions.verify('garbage.token.value', 'user')).rejects.toMatchObject({
      code: 'identity.invalid_token',
    });
  });

  it('词表外 realm 签发/验签拒绝(B08 双路径)', async () => {
    const h = harness();
    const token = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    await expect(h.api.sessions.sign({ realm: 'service', subjectId: 1 })).rejects.toMatchObject({
      code: 'identity.unknown_realm',
    });
    await expect(h.api.sessions.verify(token, 'service')).rejects.toMatchObject({
      code: 'identity.unknown_realm',
    });
  });
});

describe('sessions.validate / logout', () => {
  it('validate:有效返回载荷;logout 后 jti 命中 → null', async () => {
    const h = harness();
    const token = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    expect(await h.api.sessions.validate(token, 'user')).toMatchObject({ sub: '1' });
    await h.api.sessions.logout(token, 'user');
    expect(await h.api.sessions.validate(token, 'user')).toBeNull();
    // 剩余 TTL 随 exp 写入黑名单
    const { jti } = await h.api.sessions.verify(token, 'user');
    expect(h.revocation.revoked.get(jti)).toBe(86_400);
  });

  it('validate:吊销存储读故障 fail-open(B06 口径)', async () => {
    const h = harness();
    const token = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    h.revocation.failReads = true;
    expect(await h.api.sessions.validate(token, 'user')).toMatchObject({ sub: '1' });
  });

  it('validate:锚点线前失效、线后有效;无锚点全有效', async () => {
    const h = harness();
    const before = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    h.advanceClockMs(1);
    await h.api.revocation.revoke({ realm: 'user', userId: 1 });
    const after = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    expect(await h.api.sessions.validate(before, 'user')).toBeNull();
    expect(await h.api.sessions.validate(after, 'user')).toMatchObject({ sub: '1' });

    const untouched = await h.api.sessions.sign({ realm: 'user', subjectId: 2 });
    expect(await h.api.sessions.validate(untouched, 'user')).toMatchObject({ sub: '2' });
  });

  it('logout 未装配 revocation → invalid_input(配置错误显式化)', async () => {
    const h = harness();
    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => {} },
      config: TEST_CONFIG,
      store: h.store,
    });
    const token = await api.sessions.sign({ realm: 'user', subjectId: 1 });
    await expect(api.sessions.logout(token, 'user')).rejects.toMatchObject({
      code: 'identity.invalid_input',
    });
  });
});

describe('revocation(锚点线)', () => {
  it('无锚点全有效;线前失效线后有效;iat 双形态(Date/毫秒);NaN 拒绝', async () => {
    const h = harness();
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: new Date(0) })).toBe(
      true,
    );
    const { invalidBefore } = await h.api.revocation.revoke({ realm: 'user', userId: 1 });
    const lineMs = Date.parse(invalidBefore);
    expect(
      await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: new Date(lineMs - 1) }),
    ).toBe(false);
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: lineMs })).toBe(true);
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: lineMs + 1 })).toBe(
      true,
    );
    await expect(
      h.api.revocation.validAt({ realm: 'user', userId: 1, iat: Number.NaN }),
    ).rejects.toMatchObject({ code: 'identity.invalid_input' });
  });

  it('单调:回填早时刻不放松线(GREATEST)', async () => {
    const h = harness();
    await h.api.revocation.advance({ realm: 'user', userId: 1, at: new Date(1_000) });
    await h.api.revocation.advance({ realm: 'user', userId: 1, at: new Date(500) });
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: 999 })).toBe(false);
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: 1_000 })).toBe(true);
  });

  it('realm 隔离:同 numeric id 的 user/admin 互不串号', async () => {
    const h = harness();
    await h.api.revocation.revoke({ realm: 'user', userId: 7 });
    expect(await h.api.revocation.validAt({ realm: 'admin', userId: 7, iat: 0 })).toBe(true);
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 7, iat: 0 })).toBe(false);
  });

  it('B08 回归:未声明 realm 写读双拒(读路径不再 fail-open)', async () => {
    const h = harness();
    await expect(h.api.revocation.revoke({ realm: 'root', userId: 1 })).rejects.toMatchObject({
      code: 'identity.unknown_realm',
    });
    await expect(
      h.api.revocation.validAt({ realm: 'root', userId: 1, iat: 0 }),
    ).rejects.toMatchObject({
      code: 'identity.unknown_realm',
    });
  });

  it('userId=0 拒绝;advance 缺省 at=当前时钟', async () => {
    const h = harness();
    await expect(h.api.revocation.revoke({ realm: 'user', userId: 0 })).rejects.toMatchObject({
      code: 'identity.invalid_user_id',
    });
    const nowIso = await h.api.revocation.advance({ realm: 'user', userId: 1 });
    expect(nowIso).toBe(h.ctx.clock.now().toISOString());
  });
});
