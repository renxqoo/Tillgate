/**
 * 账户服务集成套件（真 PG）：注册/登录/改密/资料 + 赠送幂等 + 爆破闸。
 * 资损不变量：注册赠送按 refKey 幂等——重复路径不产生第二笔入账。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db';
import { verifyPassword, WeakPasswordError } from '@ai-gateway/identity-core';
import type { AuthFailureGuard, KeyBruteForceGuard } from '@ai-gateway/core';
import { systemContext } from '@ai-gateway/service';
import { createAuthService } from '../services/auth.service.js';
import { authRoutes } from '../routes/auth.js';
import { AppError } from '../http/error-map.js';
import {
  db,
  openKeyGuard,
  openIpGuard,
  neverHitCounter,
  email,
  expectAmountEq,
  balanceOf,
  newUser,
  password,
  trackUser,
  uid,
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-auth');
const PASSWORD = password();

function buildService(overrides: Partial<Parameters<typeof createAuthService>[0]> = {}) {
  return createAuthService({
    db,
    wallet,
    jwtSecret: 'test-secret-client-api-v2',
    sessionTtlSeconds: 60,
    registerEnabled: true,
    giftAmount: '0',
    loginGuard: openKeyGuard,
    ipGuard: openIpGuard,
    registerLimiter: neverHitCounter,
    registerIpLimitPerHour: 5,
    mailer: null,
    captcha: null,
    emailCodeRequired: false,
    ...overrides,
  });
}

describe('注册', () => {
  it('happy path：建号（哈希落库，明文不落库）+ 返回会话 token', async () => {
    const service = buildService();
    const mail = email();
    const result = await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    await trackUser(result.userId);
    expect(result.userId).toBeGreaterThan(0);
    expect(result.token).toBeTruthy();
    expect(result.gifted).toBe(false);

    const [row] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(row!.passwordHash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, row!.passwordHash)).toBe(true);
  });

  it('弱密码拒绝（<10 位）', async () => {
    const service = buildService();
    await expect(
      service.register(ctx, { email: email(), password: 'short', ip: '1.1.1.1' }),
    ).rejects.toThrow(WeakPasswordError);
  });

  it('重复邮箱 409（预检与唯一索引兜底两路）', async () => {
    const service = buildService();
    const mail = email();
    const first = await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    if (first.kind !== 'success') throw new Error('expected success');
    await trackUser(first.userId);
    // 预检路径
    await expect(
      service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
    // 大小写归一后同邮箱
    await expect(
      service.register(ctx, { email: mail.toUpperCase(), password: PASSWORD, ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('注册开关关闭 → 403（先于一切检查短路）', async () => {
    const service = buildService({ registerEnabled: false });
    await expect(
      service.register(ctx, { email: email(), password: PASSWORD, ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ code: 'register_disabled' });
  });

  it('同 IP 超注册配额 → 429', async () => {
    let hits = 0;
    const service = buildService({
      registerLimiter: { hit: async () => ++hits },
    });
    for (let i = 0; i < 5; i++) {
      const ok = await service.register(ctx, { email: email(), password: PASSWORD, ip: '9.9.9.9' });
      if (ok.kind !== 'success') throw new Error('expected success');
      await trackUser(ok.userId);
    }
    await expect(
      service.register(ctx, { email: email(), password: PASSWORD, ip: '9.9.9.9' }),
    ).rejects.toMatchObject({ code: 'register_rate_limited' });
  });

  it('赠送金额幂等：refKey 重放不产生第二笔入账', async () => {
    const service = buildService({ giftAmount: '5' });
    const mail = email();
    const result = await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    await trackUser(result.userId);
    expect(result.gifted).toBe(true);
    expectAmountEq(await balanceOf(result.userId), '5');
    // 同命令重放同一 refKey（模拟补发/重试路径）——幂等返回，不产生第二笔
    await wallet.credit(ctx, {
      userId: result.userId,
      amount: '5',
      refType: 'gift',
      refId: `signup:${result.userId}`,
      memo: '注册赠送',
    });
    expectAmountEq(await balanceOf(result.userId), '5');
    // 同键异命令（改 memo）→ 结构性 409（幂等冲突，不是第二笔入账）
    await expect(
      wallet.credit(ctx, {
        userId: result.userId,
        amount: '5',
        refType: 'gift',
        refId: `signup:${result.userId}`,
        memo: '篡改过的命令',
      }),
    ).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
  });
});

describe('登录', () => {
  it('happy path：token + lastLoginAt 更新', async () => {
    const account = await newUser();
    const service = buildService();
    const result = await service.login(ctx, { email: account.email, password: PASSWORD, ip: '2.2.2.2' });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.userId).toBe(account.id);
    expect(result.token).toBeTruthy();
    const [row] = await db.select().from(users).where(eq(users.id, account.id));
    expect(row!.lastLoginAt).not.toBeNull();
  });

  it('密码错误 / 账号不存在 → 同一 401（防枚举）', async () => {
    const service = buildService();
    const account = await newUser();
    const wrong = service.login(ctx, { email: account.email, password: 'wrong-password-123', ip: '2.2.2.2' });
    const unknown = service.login(ctx, { email: uid('ghost') + '@example.com', password: PASSWORD, ip: '2.2.2.2' });
    await expect(wrong).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    await expect(unknown).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('封禁账号：密码对 → 403；密码错 → 401（不泄漏封禁状态）', async () => {
    const account = await newUser();
    await db.update(users).set({ status: 1 }).where(eq(users.id, account.id));
    const service = buildService();
    await expect(
      service.login(ctx, { email: account.email, password: PASSWORD, ip: '2.2.2.2' }),
    ).rejects.toMatchObject({ status: 403, code: 'account_unavailable' });
    await expect(
      service.login(ctx, { email: account.email, password: 'wrong-password-123', ip: '2.2.2.2' }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('爆破锁生效（per-邮箱）→ 429；成功登录清零', async () => {
    const account = await newUser();
    const failures: Map<string, number> = new Map();
    let locked = false;
    const loginGuard: KeyBruteForceGuard = {
      async isLocked() {
        return { locked, retryAfterSec: locked ? 600 : 0 };
      },
      async recordFailure(key) {
        const n = (failures.get(key) ?? 0) + 1;
        failures.set(key, n);
        if (n >= 5) locked = true;
        return { locked, retryAfterSec: locked ? 600 : 0 };
      },
      async recordSuccess() {
        locked = false;
      },
    };
    const service = buildService({ loginGuard });
    for (let i = 0; i < 5; i++) {
      await expect(
        service.login(ctx, { email: account.email, password: 'wrong-password-123', ip: '2.2.2.2' }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      service.login(ctx, { email: account.email, password: PASSWORD, ip: '2.2.2.2' }),
    ).rejects.toMatchObject({ status: 429, code: 'login_locked' });
  });

  it('IP 维度锁生效（换账号遍历被挡）', async () => {
    const ipGuard: AuthFailureGuard = {
      async isLocked(ip) {
        return { locked: ip === '3.3.3.3', retryAfterSec: ip === '3.3.3.3' ? 300 : 0 };
      },
      async recordFailure() {
        return { locked: false, retryAfterSec: 0 };
      },
    };
    const service = buildService({ ipGuard });
    const account = await newUser();
    await expect(
      service.login(ctx, { email: account.email, password: PASSWORD, ip: '3.3.3.3' }),
    ).rejects.toMatchObject({ status: 429, code: 'login_locked' });
    await expect(
      service.login(ctx, { email: account.email, password: PASSWORD, ip: '4.4.4.4' }),
    ).resolves.toMatchObject({ kind: 'success', userId: account.id });
  });
});

describe('改密（R5-2）', () => {
  it('happy path：新哈希落库 + 会话失效线推进 + 返回新 token', async () => {
    const account = await newUser();
    const service = buildService();
    const before = Date.now();
    const result = await service.changePassword(ctx, {
      userId: account.id,
      oldPassword: PASSWORD,
      newPassword: 'new-shiny-password-42',
    });
    expect(result.token).toBeTruthy();
    const [row] = await db.select().from(users).where(eq(users.id, account.id));
    expect(await verifyPassword('new-shiny-password-42', row!.passwordHash)).toBe(true);
    expect(row!.sessionInvalidBefore!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('原密码错误 → 401，哈希不变', async () => {
    const account = await newUser();
    const service = buildService();
    await expect(
      service.changePassword(ctx, {
        userId: account.id,
        oldPassword: 'wrong-password-123',
        newPassword: 'new-shiny-password-42',
      }),
    ).rejects.toMatchObject({ status: 401 });
    const [row] = await db.select().from(users).where(eq(users.id, account.id));
    expect(await verifyPassword(PASSWORD, row!.passwordHash)).toBe(true);
  });

  it('新密码弱 → 400（identity-core 策略）', async () => {
    const account = await newUser();
    const service = buildService();
    await expect(
      service.changePassword(ctx, { userId: account.id, oldPassword: PASSWORD, newPassword: 'short' }),
    ).rejects.toThrow(WeakPasswordError);
  });
});

describe('资料', () => {
  it('profile：基本信息 + 钱包余额摘要', async () => {
    const account = await newUser();
    await wallet.credit(ctx, {
      userId: account.id,
      amount: '7.5',
      refType: 'gift',
      refId: `profile-${randomUUID()}`,
    });
    const service = buildService();
    const profile = await service.profile(ctx, account.id);
    expect(profile.id).toBe(account.id);
    expect(profile.email).toBe(account.email);
    expectAmountEq(
      profile.accounts.find((a) => a.currency === 'CNY')?.balance ?? '0',
      '7.5',
    );
  });

  it('自助改显示名（PATCH /v1/me/display-name 语义）', async () => {
    const account = await newUser();
    const service = buildService();
    const result = await service.updateDisplayName(ctx, account.id, '新名字');
    expect(result.displayName).toBe('新名字');
    const profile = await service.profile(ctx, account.id);
    expect(profile.displayName).toBe('新名字');
  });

  it('AppError 形状自检（status/code/message 齐备）', () => {
    const err = new AppError(409, 'email_taken', 'x');
    expect(err.status).toBe(409);
    expect(err.code).toBe('email_taken');
  });
});

describe('来源 IP 提取语义（XFF / v1 auth-throttle-xff 对齐）', () => {
  it('TRUSTED_PROXY_HOPS=0：直连地址，XFF 不信；=1：取 XFF 右数第 1 跳', async () => {
    const seen: string[] = [];
    const stub = {
      register: async (_ctx: unknown, input: { ip: string }) => {
        seen.push(input.ip);
        return { kind: 'success', token: 't', userId: 1, email: 'e', gifted: false };
      },
      login: async () => ({ kind: 'success', token: 't', userId: 1 }),
      verifyRegistration: async () => ({ kind: 'success', token: 't', userId: 1, email: 'e', gifted: false }),
      verifyLogin: async () => ({ token: 't', userId: 1 }),
      changePassword: async () => ({ token: 't' }),
      profile: async () => ({ id: 1, email: null, displayName: null, createdAt: new Date(), accounts: [] }),
      updateDisplayName: async () => ({ displayName: 'x' }),
    } as unknown as import('../services/auth.service.js').AuthService;

    for (const hops of [0, 1]) {
      const routes = authRoutes(stub, {
        session: async (_c, next) => await next(),
        trustedProxyHops: hops,
      });
      await routes.request('/v1/auth/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '1.2.3.4, 5.6.7.8',
        },
        body: JSON.stringify({ email: 'xff@example.com', password: PASSWORD }),
      });
    }
    console.log("SEEN", JSON.stringify(seen));
    expect(seen[0]).not.toBe('5.6.7.8');
    // 信 1 跳：取 XFF 右数第 1 跳（最近代理写入的客户端地址）
    expect(seen[1]).toBe('5.6.7.8');
  });
});
