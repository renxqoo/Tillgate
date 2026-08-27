/**
 * 密码用例测试:
 * 防枚举统一口径、改密正确流(吊销线推进)、旧密错不动、reset 免旧密、
 * 锁内验旧密——并发 reset 不被覆盖的回归。
 */
import { describe, expect, it } from 'vitest';
import { createTestHarness } from '../src/testing/harness.js';

const harness = () => createTestHarness();
const email = (n: number) => `pw${n}@example.com`;

async function registerWithPassword(
  h: ReturnType<typeof harness>,
  userId: number,
  password: string,
) {
  await h.api.credentials.register({
    userId,
    identifier: { kind: 'email', value: email(userId) },
    password,
  });
}

describe('passwords.authenticate(防枚举契约)', () => {
  it('正确密码返回 userId;归一形态匹配', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    const result = await h.api.passwords.authenticate({
      identifier: { kind: 'email', value: `  ${email(1).toUpperCase()} ` },
      password: 'password-123456',
    });
    expect(result).toEqual({ userId: 1 });
  });

  it('未知标识与错密码同 code 同文案(防枚举)', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    const unknown = await h.api.passwords
      .authenticate({ identifier: { kind: 'email', value: email(99) }, password: 'whatever-12345' })
      .catch((error: Error) => error);
    const wrong = await h.api.passwords
      .authenticate({ identifier: { kind: 'email', value: email(1) }, password: 'whatever-12345' })
      .catch((error: Error) => error);
    expect(unknown).toMatchObject({ code: 'identity.invalid_credentials' });
    expect((unknown as Error).message).toBe((wrong as Error).message);
    expect((wrong as { code?: string }).code).toBe('identity.invalid_credentials');
  });

  it('OAuth-only 账号(无密码行)→ invalid_credentials(设初始密码走 reset)', async () => {
    const h = harness();
    await h.api.credentials.register({ userId: 1, identifier: { kind: 'email', value: email(2) } });
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(2) },
        password: 'x'.repeat(20),
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_credentials' });
  });

  it('密码非字符串不 TypeError(统一 invalid_credentials)', async () => {
    const h = harness();
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(3) },
        password: undefined as unknown as string,
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_credentials' });
  });

  it('审计成败双发(B10)', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    await h.api.passwords.authenticate({
      identifier: { kind: 'email', value: email(1) },
      password: 'password-123456',
    });
    await h.api.passwords
      .authenticate({ identifier: { kind: 'email', value: email(1) }, password: 'wrong-pass-1234' })
      .catch(() => {});
    const outcomes = h.audit.events
      .filter((e) => e.action === 'credential.authenticate')
      .map((e) => (e.detail as { outcome: string }).outcome);
    expect(outcomes).toEqual(['success', 'failure']);
  });
});

describe('passwords.change(B04:验旧密入锁内临界区)', () => {
  it('正确流:换哈希 + 推进吊销线(旧线前会话失效,线后有效)', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    const beforeToken = await h.api.sessions.sign({ realm: 'user', subjectId: 1 });
    h.advanceClockMs(1);
    const { invalidBefore } = await h.api.passwords.change({
      userId: 1,
      realm: 'user',
      currentPassword: 'password-123456',
      newPassword: 'new-password-654321',
    });
    expect(invalidBefore).toBe(new Date(h.ctx.clock.now()).toISOString());
    // 旧会话失效(签发时刻早于线)
    expect(await h.api.sessions.validate(beforeToken, 'user')).toBeNull();
    // 新密码可认证;旧密码不再可用
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(1) },
        password: 'new-password-654321',
      }),
    ).resolves.toEqual({ userId: 1 });
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(1) },
        password: 'password-123456',
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_credentials' });
  });

  it('旧密错误:哈希与吊销线均不动', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    await expect(
      h.api.passwords.change({
        userId: 1,
        realm: 'user',
        currentPassword: 'wrong-old-pass-1',
        newPassword: 'new-password-654321',
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_credentials' });
    expect(await h.api.revocation.validAt({ realm: 'user', userId: 1, iat: new Date(0) })).toBe(
      true,
    );
  });

  it('B04 回归:改密期间并发 reset 不被旧密覆盖(锁内验旧密读到的是最新哈希)', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    // reset 先落新哈希,再持旧密码尝试 change——必须失败而不是覆盖 reset
    await h.api.passwords.reset({ userId: 1, realm: 'user', newPassword: 'reset-password-9' });
    await expect(
      h.api.passwords.change({
        userId: 1,
        realm: 'user',
        currentPassword: 'password-123456',
        newPassword: 'attacker-swap-99',
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_credentials' });
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(1) },
        password: 'reset-password-9',
      }),
    ).resolves.toEqual({ userId: 1 });
  });

  it('弱口令:拒绝且原密码保持', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    await expect(
      h.api.passwords.change({
        userId: 1,
        realm: 'user',
        currentPassword: 'password-123456',
        newPassword: 'short',
      }),
    ).rejects.toMatchObject({ code: 'identity.weak_password' });
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(1) },
        password: 'password-123456',
      }),
    ).resolves.toEqual({ userId: 1 });
  });
});

describe('passwords.reset', () => {
  it('免旧密 + 推进吊销线 + 可给 OAuth-only 账号设初始密码', async () => {
    const h = harness();
    await h.api.credentials.register({ userId: 1, identifier: { kind: 'email', value: email(4) } });
    const { invalidBefore } = await h.api.passwords.reset({
      userId: 1,
      realm: 'user',
      newPassword: 'initial-password-7',
    });
    expect(invalidBefore).toBe(new Date(h.ctx.clock.now()).toISOString());
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(4) },
        password: 'initial-password-7',
      }),
    ).resolves.toEqual({ userId: 1 });
  });

  it('弱口令拒绝时旧密码保持', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    await expect(
      h.api.passwords.reset({ userId: 1, realm: 'user', newPassword: 'short' }),
    ).rejects.toMatchObject({ code: 'identity.weak_password' });
    await expect(
      h.api.passwords.authenticate({
        identifier: { kind: 'email', value: email(1) },
        password: 'password-123456',
      }),
    ).resolves.toEqual({ userId: 1 });
  });

  it('审计:change/reset 均带 realm(B09 管理面补齐)', async () => {
    const h = harness();
    await registerWithPassword(h, 1, 'password-123456');
    await h.api.passwords.reset({ userId: 1, realm: 'admin', newPassword: 'admin-reset-pass-1' });
    const event = h.audit.events.find((e) => e.action === 'password.reset');
    expect(event?.detail).toMatchObject({ realm: 'admin' });
  });
});
