/**
 * 邮箱验证码两步流 + 人机验证门禁（真 PG + 假 mailer/captcha 注入）：
 * v1 auth-register/auth-email-login/auth-register-captcha/auth-register-switch 的语义等价覆盖。
 * 关键不变量：密码哈希不落明文（存挑战）；密码对不签会话（必须验码）；
 * SMTP/厂商不可用 fail-closed；验码一次性消费。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db';
import { CaptchaError, type CaptchaService, type Mailer } from '@ai-gateway/identity';
import { systemContext } from '@ai-gateway/service';
import { createAuthService } from '../services/auth.service.js';
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
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-authcode');
const PASSWORD = password();

/** 假 mailer：捕获验证码（6 位数字从投递内容截获） */
function fakeMailer() {
  const sent: Array<{ to: string; code: string }> = [];
  const mailer: Mailer = {
    async sendLoginCode(to, code) {
      sent.push({ to, code });
    },
    async send() {},
  };
  return { mailer, sent, lastCode: () => sent.at(-1)!.code };
}

type CaptchaBehavior = 'ok' | 'invalid' | 'unavailable';
function fakeCaptcha(behavior: CaptchaBehavior): CaptchaService {
  return {
    siteKey: 'site-key-x',
    async verify() {
      if (behavior === 'invalid') throw new CaptchaError('invalid');
      if (behavior === 'unavailable') throw new CaptchaError('unavailable');
    },
  };
}

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

describe('两步注册（邮箱验证码）', () => {
  it('register → code_required（无会话）→ 验码建号 + 会话 + 赠送', async () => {
    const { mailer, lastCode } = fakeMailer();
    const service = buildService({ mailer, emailCodeRequired: true, giftAmount: '5' });
    const mail = email();

    const step1 = await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    expect(step1.kind).toBe('code_required');
    if (step1.kind !== 'code_required') throw new Error();
    expect(lastCode()).toMatch(/^\d{6}$/);

    const step2 = await service.verifyRegistration(ctx, { challengeId: step1.challengeId, code: lastCode() });
    expect(step2.kind).toBe('success');
    await trackUser(step2.userId);
    expect(step2.gifted).toBe(true);
    expectAmountEq(await balanceOf(step2.userId), '5');
    // 明文密码不落库
    const [row] = await db.select().from(users).where(eq(users.id, step2.userId));
    expect(row!.passwordHash).not.toContain(PASSWORD);
  });

  it('错码 400；一次性消费（重放挑战 → challenge_invalid）', async () => {
    const { mailer, lastCode } = fakeMailer();
    const service = buildService({ mailer, emailCodeRequired: true });
    const mail = email();
    const step1 = await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    if (step1.kind !== 'code_required') throw new Error();

    await expect(
      service.verifyRegistration(ctx, { challengeId: step1.challengeId, code: '000000' }),
    ).rejects.toMatchObject({ code: 'code_invalid' });
    // 用截获的真码验证成功
    const ok = await service.verifyRegistration(ctx, { challengeId: step1.challengeId, code: lastCode() });
    await trackUser(ok.kind === 'success' ? ok.userId : 0);
    // 同挑战重放 → 挑战已消费
    await expect(
      service.verifyRegistration(ctx, { challengeId: step1.challengeId, code: lastCode() }),
    ).rejects.toMatchObject({ code: 'challenge_invalid' });
  });

  it('60s 冷却 → 429（同邮箱连发）', async () => {
    const { mailer } = fakeMailer();
    const service = buildService({ mailer, emailCodeRequired: true });
    const mail = email();
    await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    await expect(
      service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ status: 429, code: 'code_rate_limited' });
    void mailer;
  });

  it('模式强制而 SMTP 未配置 → 503 fail-closed（不降级单步）', async () => {
    const service = buildService({ mailer: null, emailCodeRequired: true });
    await expect(
      service.register(ctx, { email: email(), password: PASSWORD, ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ status: 503, code: 'two_factor_unavailable' });
  });

  it('开关关闭后 verify → 403（防发码后翻转窗口建号）', async () => {
    const { mailer, lastCode } = fakeMailer();
    const enabled = buildService({ mailer, emailCodeRequired: true });
    const mail = email();
    const step1 = await enabled.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' });
    if (step1.kind !== 'code_required') throw new Error();
    const disabled = buildService({ mailer, emailCodeRequired: true, registerEnabled: false });
    await expect(
      disabled.verifyRegistration(ctx, { challengeId: step1.challengeId, code: lastCode() }),
    ).rejects.toMatchObject({ status: 403, code: 'register_disabled' });
  });
});

describe('两步登录（密码对不签会话）', () => {
  it('login → code_required（无 token）→ 验码签会话', async () => {
    const account = await newUser();
    const { mailer, lastCode } = fakeMailer();
    const service = buildService({ mailer, emailCodeRequired: true });

    const step1 = await service.login(ctx, { email: account.email, password: PASSWORD, ip: '2.2.2.2' });
    expect(step1.kind).toBe('code_required');
    if (step1.kind !== 'code_required') throw new Error();
    expect((step1 as { token?: string }).token).toBeUndefined();

    const step2 = await service.verifyLogin(ctx, { challengeId: step1.challengeId, code: lastCode() });
    expect(step2.token).toBeTruthy();
    expect(step2.userId).toBe(account.id);
  });

  it('密码错 → 401 且不发码；封禁账号 → 403（密码对也不发码）', async () => {
    const account = await newUser();
    const probe = fakeMailer();
    const service = buildService({ mailer: probe.mailer, emailCodeRequired: true });
    await expect(
      service.login(ctx, { email: account.email, password: 'wrong-password-123', ip: '2.2.2.2' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(probe.sent.length).toBe(0);

    await db.update(users).set({ status: 1 }).where(eq(users.id, account.id));
    await expect(
      service.login(ctx, { email: account.email, password: PASSWORD, ip: '2.2.2.2' }),
    ).rejects.toMatchObject({ status: 403, code: 'account_unavailable' });
    expect(probe.sent.length).toBe(0);
  });
});

describe('人机验证门禁（注册面）', () => {
  it('缺 token 400 / 无效 400 / 厂商不可达 503（fail-closed）/ 通过放行', async () => {
    const mail = email();
    // 启用 captcha（注册恒两步——聚焦 captcha 语义；发码阶段先过 captcha）
    const fm = fakeMailer();
    const service = buildService({ captcha: fakeCaptcha('ok'), mailer: fm.mailer });
    await expect(
      service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1' }),
    ).rejects.toMatchObject({ status: 400, code: 'captcha_required' });
    const issued = await service.register(ctx, { email: mail, password: PASSWORD, ip: '1.1.1.1', captchaToken: 'tok' });
    expect(issued.kind).toBe('code_required');
    const done = await service.verifyRegistration(ctx, {
      challengeId: (issued as { challengeId: string }).challengeId,
      code: fm.lastCode(),
    });
    expect(done.kind).toBe('success');

    const invalid = buildService({ captcha: fakeCaptcha('invalid') });
    await expect(
      invalid.register(ctx, { email: email(), password: PASSWORD, ip: '1.1.1.1', captchaToken: 'tok' }),
    ).rejects.toMatchObject({ status: 400, code: 'captcha_invalid' });

    const down = buildService({ captcha: fakeCaptcha('unavailable') });
    await expect(
      down.register(ctx, { email: email(), password: PASSWORD, ip: '1.1.1.1', captchaToken: 'tok' }),
    ).rejects.toMatchObject({ status: 503, code: 'captcha_unavailable' });
  });

  it('能力探测：注册开关 / siteKey / 验证码模式', () => {
    const on = buildService({ captcha: fakeCaptcha('ok'), mailer: fakeMailer().mailer, emailCodeRequired: true });
    expect(on.capabilities()).toEqual({
      registerEnabled: true,
      captchaSiteKey: 'site-key-x',
      emailCodeRequired: true,
    });
    const off = buildService({ registerEnabled: false });
    expect(off.capabilities()).toEqual({
      registerEnabled: false,
      captchaSiteKey: null,
      emailCodeRequired: false,
    });
  });
});
