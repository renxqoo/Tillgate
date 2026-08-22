/**
 * facade 装配(DESIGN §2.2):必填契约(零隐藏默认)、测试缝(store/auditSink 注入)、
 * 内部适配器默认装配路径不破坏动词表形状。
 */
import { describe, expect, it } from 'vitest';
import { createAccounts, type AccountsPolicy } from '../src/index.js';
import {
  V1_POLICY,
  createInMemoryAuditSink,
  createInMemoryWalletCredit,
  createTestHarness,
} from '../src/testing/harness.js';

describe('createAccounts 装配契约', () => {
  it('缺 policy/txRetry/now/db/walletCredit 在类型面编译失败(零隐藏默认)', () => {
    // @ts-expect-error 缺全部必填——必填契约的类型面证明
    createAccounts({});
    expect(true).toBe(true);
  });

  it('store 注入缝:替身直通,动词表完整绑定', async () => {
    const h = createTestHarness();
    const api = createAccounts({
      db: h.ctx.db, // harness 的快照回滚 fake db(生产为真实池句柄)
      walletCredit: h.wallet,
      policy: V1_POLICY,
      txRetry: { maxAttempts: 2, baseDelayMs: 1, maxJitterMs: 1 },
      now: () => new Date('2026-08-23T00:00:00Z'),
      store: h.store,
      auditSink: createInMemoryAuditSink(),
    });
    const user = await api.provisionLocalAccount({ email: 'facade@x.io' });
    expect(user.email).toBe('facade@x.io');
    // 动词表覆盖面(与 AccountUseCases 接口一一对应)
    const verbs = Object.keys(api).toSorted();
    expect(verbs.length).toBe(42);
  });

  it('policy 逐字段必填(部分缺省编译失败)', () => {
    // @ts-expect-error keyPrefix:undefined 不满足必填 string——逐字段必填的类型面证明
    const bad: AccountsPolicy = { ...V1_POLICY, keyPrefix: undefined };
    expect([bad]).toBeDefined();
  });

  it('wallet 替身独立可注入(billing 桥接前的装配形态)', () => {
    const wallet = createInMemoryWalletCredit();
    expect(wallet.credits).toEqual([]);
  });
});
