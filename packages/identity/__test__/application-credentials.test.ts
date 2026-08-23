/**
 * 凭据用例测试(v1 credentials.test 迁移):注册落行、幂等重挂、他人占用、
 * 并发单赢家(内存复演)、密码策略单源(B18/B23 显式化)、composition bridge
 * 回滚语义(B03)。
 */
import { describe, expect, it } from 'vitest';
import { identityWithinTx } from '../src/composition.js';
import { resolveConfig } from '../src/domain/config.js';
import { TEST_CONFIG, createTestHarness } from '../src/testing/harness.js';

const harness = () => createTestHarness();
const email = (n: number) => `user${n}@example.com`;

describe('credentials.register', () => {
  it('注册落行 + 首密码落库;同用户重挂幂等同 credentialId(B23:重放不改密码)', async () => {
    const h = harness();
    const first = await h.api.credentials.register({
      userId: 1,
      identifier: { kind: 'email', value: email(1) },
      password: 'password-123456',
    });
    expect(first.replayed).toBe(false);
    const row = await h.store.findPasswordHashByIdentifier(h.ctx.db, {
      kind: 'email',
      value: email(1),
    });
    expect(row).not.toBeNull();

    const second = await h.api.credentials.register({
      userId: 1,
      identifier: { kind: 'email', value: `  ${email(1).toUpperCase()} ` },
    });
    expect(second).toEqual({ credentialId: first.credentialId, replayed: true });
  });

  it('他人占用 → identifier_taken(归一形态唯一)', async () => {
    const h = harness();
    await h.api.credentials.register({ userId: 1, identifier: { kind: 'email', value: email(2) } });
    await expect(
      h.api.credentials.register({
        userId: 2,
        identifier: { kind: 'email', value: `  ${email(2).toUpperCase()} ` },
      }),
    ).rejects.toMatchObject({ code: 'identity.identifier_taken' });
  });

  it('首密码走单源策略(B18):弱口令注册整体拒绝,不落凭据行', async () => {
    const h = harness();
    await expect(
      h.api.credentials.register({
        userId: 1,
        identifier: { kind: 'email', value: email(3) },
        password: 'short',
      }),
    ).rejects.toMatchObject({ code: 'identity.weak_password' });
    expect(
      await h.store.findPasswordHashByIdentifier(h.ctx.db, { kind: 'email', value: email(3) }),
    ).toBeNull();
  });

  it('并发注册同邮箱恰一人成功(内存单赢家复演;真实 PG 门禁复验)', async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.api.credentials.register({ userId: 101, identifier: { kind: 'email', value: email(4) } }),
      h.api.credentials.register({ userId: 102, identifier: { kind: 'email', value: email(4) } }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'identity.identifier_taken',
    });
  });

  it('审计在注册后发射(B03):事件可见且动作区分 register/replay', async () => {
    const h = harness();
    await h.api.credentials.register({ userId: 1, identifier: { kind: 'email', value: email(5) } });
    await h.api.credentials.register({ userId: 1, identifier: { kind: 'email', value: email(5) } });
    expect(h.audit.events.map((e) => e.action)).toEqual([
      'credential.register',
      'credential.replay',
    ]);
  });
});

describe('composition bridge:identityWithinTx(B03/B16 契约)', () => {
  it('bridge 不发射审计——事件交还调用方提交后冲洗(回滚即丢弃)', async () => {
    const h = harness();
    const { guards, config } = resolveConfig(TEST_CONFIG);
    // fake db 结构上非 DbTx(内存 store 无视 tx;advisoryLock 走 no-op execute);
    // 随事务回滚的落库语义由 postgres.real 门禁复验
    const bridge = identityWithinTx(h.ctx.db as unknown as Parameters<typeof identityWithinTx>[0], {
      clock: h.ctx.clock,
      guards,
      passwordPolicy: config.passwordPolicy,
      auditSink: h.audit,
      credentialStore: h.store,
    });

    const result = await bridge.registerCredential({
      userId: 1,
      identifier: { kind: 'email', value: email(6) },
    });
    // 契约:bridge 不发射审计——事件交还调用方提交后冲洗(回滚即丢弃;
    // 随事务回滚的落库语义由 postgres.real 门禁复验,内存替身无视 tx)
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]!.action).toBe('credential.register');
    expect(h.audit.events).toHaveLength(0);
    await h.audit.record(result.auditEvents[0]!);
    expect(h.audit.events).toHaveLength(1);
  });

  it('预哈希路径:非本包 scrypt 格式拒绝(防脏哈希入库=认证永远失败)', async () => {
    const h = harness();
    const { guards, config } = resolveConfig(TEST_CONFIG);
    const bridge = identityWithinTx(h.ctx.db as unknown as Parameters<typeof identityWithinTx>[0], {
      clock: h.ctx.clock,
      guards,
      passwordPolicy: config.passwordPolicy,
    });
    await expect(
      bridge.registerCredential({
        userId: 1,
        identifier: { kind: 'email', value: email(7) },
        passwordHash: 'bcrypt$2b$12$not-ours',
      }),
    ).rejects.toMatchObject({ code: 'identity.invalid_input' });
  });
});
