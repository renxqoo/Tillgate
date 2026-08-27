/**
 * MFA 用例测试:挂起/确认两段注册、恢复码 HMAC 哈希落库、
 * 步号单调防重放、恢复码单次消费、disable 守卫、cipher 密文落库。
 */
import { describe, expect, it } from 'vitest';
import { base32Decode, matchingTotpStep, totpAt } from '../src/domain/totp.js';
import { createTestHarness } from '../src/testing/harness.js';
import { defined } from './defined.js';

const harness = () => createTestHarness();

/** 用 enrolled secret 生成当前有效码(步进与 harness 时钟一致) */
function currentCode(h: ReturnType<typeof harness>, secretBase32: string): string {
  const secret = base32Decode(secretBase32);
  const epochMs = h.ctx.clock.now().getTime();
  const step = matchingTotpStep(secret, totpAt(secret, epochMs, 30), epochMs, 30, 1);
  return totpAt(secret, step != null ? step * 30_000 : epochMs, 30);
}

function nextCode(h: ReturnType<typeof harness>, secretBase32: string): string {
  const secret = base32Decode(secretBase32);
  const step = Math.floor(h.ctx.clock.now().getTime() / 1000 / 30) + 1;
  return totpAt(secret, step * 30_000, 30);
}

describe('mfa 两段注册', () => {
  it('enroll 挂起 → confirm 生效;恢复码 10 张只存哈希(B13 HMAC)', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    expect(enrolled.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrolled.otpauthUrl).toContain('otpauth://totp/');
    expect(enrolled.otpauthUrl).toContain(`secret=${enrolled.secret}`);

    const { recoveryCodes } = await h.api.mfa.confirmTotp({
      userId: 1,
      code: currentCode(h, enrolled.secret),
    });
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
    }
    // 库内确认态落位(明文 secret 只在 enroll 返回这一次——密文形态由 cipher 用例验证)
    const totpRow = await h.store.loadTotp(h.ctx.db, 1);
    expect(totpRow?.confirmedAt).not.toBeNull();
  });

  it('confirm 错码仍挂起;已确认后再 enroll/confirm → already', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    await expect(h.api.mfa.confirmTotp({ userId: 1, code: '000000' })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    expect((await h.store.loadTotp(h.ctx.db, 1))?.confirmedAt).toBeNull();

    await h.api.mfa.confirmTotp({ userId: 1, code: currentCode(h, enrolled.secret) });
    await expect(h.api.mfa.enrollTotp({ userId: 1 })).rejects.toMatchObject({
      code: 'identity.totp_already_enrolled',
    });
    await expect(h.api.mfa.confirmTotp({ userId: 1, code: '000000' })).rejects.toMatchObject({
      code: 'identity.totp_already_enrolled',
    });
  });

  it('挂起重挂换新钥(旧钥码失效)', async () => {
    const h = harness();
    const first = await h.api.mfa.enrollTotp({ userId: 1 });
    const second = await h.api.mfa.enrollTotp({ userId: 1 });
    expect(second.secret).not.toBe(first.secret);
    await expect(
      h.api.mfa.confirmTotp({ userId: 1, code: currentCode(h, first.secret) }),
    ).rejects.toMatchObject({ code: 'identity.invalid_totp_code' });
    await expect(
      h.api.mfa.confirmTotp({ userId: 1, code: currentCode(h, second.secret) }),
    ).resolves.toBeTruthy();
  });
});

describe('mfa.verify(步号单调防重放)', () => {
  it('confirm 码不可重放(步号已消费);下一码可用且同样不可重放(v1 步号单调语义)', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    const confirmCode = currentCode(h, enrolled.secret);
    await h.api.mfa.confirmTotp({ userId: 1, code: confirmCode });
    // confirm 已把该步号记入 lastUsedStep——同一码 verify 被单调 CAS 拒绝
    await expect(h.api.mfa.verify({ userId: 1, code: confirmCode })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    const next = nextCode(h, enrolled.secret);
    await expect(h.api.mfa.verify({ userId: 1, code: next })).resolves.toEqual({ method: 'totp' });
    await expect(h.api.mfa.verify({ userId: 1, code: next })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    h.advanceClockMs(30_000);
    const next2 = nextCode(h, enrolled.secret);
    await expect(h.api.mfa.verify({ userId: 1, code: next2 })).resolves.toEqual({ method: 'totp' });
    await expect(h.api.mfa.verify({ userId: 1, code: next2 })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
  });

  it('恢复码单次消费;第二张仍可用;乱码统一 invalid_totp_code', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    const { recoveryCodes } = await h.api.mfa.confirmTotp({
      userId: 1,
      code: currentCode(h, enrolled.secret),
    });
    const [first, second] = recoveryCodes;
    await expect(
      h.api.mfa.verify({ userId: 1, code: defined(first, 'first').toLowerCase() }),
    ).resolves.toEqual({
      method: 'recovery',
    });
    await expect(
      h.api.mfa.verify({ userId: 1, code: defined(first, 'first') }),
    ).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    await expect(h.api.mfa.verify({ userId: 1, code: defined(second, 'second') })).resolves.toEqual(
      {
        method: 'recovery',
      },
    );
    await expect(h.api.mfa.verify({ userId: 1, code: 'ZZZZZZZZZZ' })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
  });

  it('未注册/挂起中 → totp_not_enrolled', async () => {
    const h = harness();
    await expect(h.api.mfa.verify({ userId: 1, code: '123456' })).rejects.toMatchObject({
      code: 'identity.totp_not_enrolled',
    });
    await h.api.mfa.enrollTotp({ userId: 1 });
    await expect(h.api.mfa.verify({ userId: 1, code: '123456' })).rejects.toMatchObject({
      code: 'identity.totp_not_enrolled',
    });
  });
});

describe('mfa.verifyTotpOnly（ADR-0011 step-up：仅 TOTP，不落恢复码分支）', () => {
  it('有效码放行且不可重放（步号单调 CAS 与 verify 同口径）', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    await h.api.mfa.confirmTotp({ userId: 1, code: currentCode(h, enrolled.secret) });
    const code = nextCode(h, enrolled.secret);
    await h.api.mfa.verifyTotpOnly({ userId: 1, code });
    await expect(h.api.mfa.verifyTotpOnly({ userId: 1, code })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
  });
  it('恢复码不被接受也不被消耗（step-up 不烧紧急通道——登录面 verify 仍可用）', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    const { recoveryCodes } = await h.api.mfa.confirmTotp({
      userId: 1,
      code: currentCode(h, enrolled.secret),
    });
    const recovery = defined(recoveryCodes[0], 'recoveryCodes[0]');
    await expect(h.api.mfa.verifyTotpOnly({ userId: 1, code: recovery })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    await expect(h.api.mfa.verify({ userId: 1, code: recovery })).resolves.toMatchObject({
      method: 'recovery',
    });
  });
  it('未绑定 → totp_not_enrolled（调用方转引导绑定）', async () => {
    const h = harness();
    await expect(h.api.mfa.verifyTotpOnly({ userId: 1, code: '123456' })).rejects.toMatchObject({
      code: 'identity.totp_not_enrolled',
    });
  });
});

describe('mfa.disableTotp', () => {
  it('已确认必须携有效码;成功后 MFA+恢复码全清,可重新注册', async () => {
    const h = harness();
    const enrolled = await h.api.mfa.enrollTotp({ userId: 1 });
    const { recoveryCodes } = await h.api.mfa.confirmTotp({
      userId: 1,
      code: currentCode(h, enrolled.secret),
    });
    await expect(h.api.mfa.disableTotp({ userId: 1 })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    await expect(h.api.mfa.disableTotp({ userId: 1, code: '000000' })).rejects.toMatchObject({
      code: 'identity.invalid_totp_code',
    });
    await expect(
      h.api.mfa.disableTotp({ userId: 1, code: nextCode(h, enrolled.secret) }),
    ).resolves.toEqual({ disabled: true });
    expect(await h.store.loadTotp(h.ctx.db, 1)).toBeNull();
    await expect(
      h.api.mfa.verify({ userId: 1, code: defined(recoveryCodes[0], 'recoveryCodes[0]') }),
    ).rejects.toMatchObject({
      code: 'identity.totp_not_enrolled',
    });
    await expect(h.api.mfa.enrollTotp({ userId: 1 })).resolves.toMatchObject({
      secret: expect.any(String),
    });
  });

  it('挂起态免码直删;未注册 → totp_not_enrolled', async () => {
    const h = harness();
    await expect(h.api.mfa.disableTotp({ userId: 1 })).rejects.toMatchObject({
      code: 'identity.totp_not_enrolled',
    });
    await h.api.mfa.enrollTotp({ userId: 1 });
    await expect(h.api.mfa.disableTotp({ userId: 1 })).resolves.toEqual({ disabled: true });
  });
});

describe('cipher 密文落库(SecretCipher)', () => {
  it('库内密文 ≠ 明文,功能不变', async () => {
    const h = harness();
    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    const encrypted = new Set<string>();
    const api = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => {} },
      config: TEST_CONFIG,
      store: h.store,
      cipher: {
        encrypt: (plain) => {
          encrypted.add(plain);
          return `enc:${Buffer.from(plain).toString('base64')}`;
        },
        decrypt: (stored) => Buffer.from(stored.slice(4), 'base64').toString(),
      },
    });
    const enrolled = await api.mfa.enrollTotp({ userId: 1 });
    const stored = await h.store.loadTotp(h.ctx.db, 1);
    expect(stored?.secret).toContain('enc:');
    expect(stored?.secret).not.toBe(enrolled.secret);
    expect(encrypted.has(enrolled.secret)).toBe(true);
    await expect(
      api.mfa.confirmTotp({ userId: 1, code: currentCode(h, enrolled.secret) }),
    ).resolves.toBeTruthy();
  });

  it('遗留明文行（装配注入 cipher 前写入）验证不回归——格式不符回落明文', async () => {
    const h = harness();
    const { createIdentity } = await import('../src/identity.js');
    const { TEST_CONFIG } = await import('../src/testing/harness.js');
    // 旧形态装配：未注入 cipher → 明文落库
    const legacy = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => {} },
      config: TEST_CONFIG,
      store: h.store,
    });
    const enrolled = await legacy.mfa.enrollTotp({ userId: 1 });
    await legacy.mfa.confirmTotp({ userId: 1, code: currentCode(h, enrolled.secret) });
    expect((await h.store.loadTotp(h.ctx.db, 1))?.secret).toBe(enrolled.secret); // 明文行
    // 新形态装配（cipher 已注入）：同一明文行仍可验证（重挂后即换密文）
    const upgraded = createIdentity({
      db: h.ctx.db,
      txRetry: h.ctx.txRetry,
      clock: h.ctx.clock,
      logger: { warn: () => {} },
      config: TEST_CONFIG,
      store: h.store,
      cipher: {
        encrypt: (plain) => `enc:v1:${Buffer.from(plain).toString('base64')}`,
        decrypt: (stored) => {
          if (!stored.startsWith('enc:v1:')) {
            throw Object.assign(new Error('invalid ciphertext format'), {
              code: 'runtime.cipher.invalid_format',
            });
          }
          return Buffer.from(stored.slice(8), 'base64').toString();
        },
      },
    });
    h.advanceClockMs(30_000); // 步进单调 CAS：新步号验证
    await expect(
      upgraded.mfa.verify({ userId: 1, code: currentCode(h, enrolled.secret) }),
    ).resolves.toEqual({ method: 'totp' });
  });
});
