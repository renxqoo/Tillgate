import { describe, expect, it } from 'vitest';
import { changeBalance, type BalanceChangeResult } from './balance.js';

/**
 * changeBalance 纯逻辑测试：用 mock Db 验证分支逻辑（不连真实 DB）。
 * 并发原子性由集成测试（balance.integration.test.ts）用真实 PG 验证。
 *
 * Mock 策略：drizzle 的 update().set().where().returning() 是链式调用，
 * 我们提供一个能返回任意 returning 结果的 mock，覆盖三条分支：
 *   - 普通变更成功（updated 非空）
 *   - 用户不存在（updated 空 + exists 空）
 *   - 余额不足（updated 空 + exists 非空，仅 checkSufficient 扣减路径）
 */

function makeMockDb(opts: {
  /** update().returning() 返回的余额行（空 = 未更新） */
  returningBalance?: number[];
  /** select exists 探针返回的行数 */
  existsRows?: number;
}) {
  const chain = {
    set: () => chain,
    where: () => chain,
    returning: () => Promise.resolve((opts.returningBalance ?? []).map((b) => ({ balance: b }))),
  };
  const selectChain = { from: () => selectChain, where: () => selectChain, limit: () => Promise.resolve(Array.from({ length: opts.existsRows ?? 0 }, () => ({ id: 1 }))) };
  return {
    update: () => chain,
    select: () => selectChain,
  } as unknown as Parameters<typeof changeBalance>[0];
}

describe('changeBalance 逻辑分支', () => {
  it('普通变更成功 → ok:true + before/after', async () => {
    const db = makeMockDb({ returningBalance: [1050] });
    const r = await changeBalance(db, 1, 50);
    expect(r.ok).toBe(true);
    expect((r as Extract<BalanceChangeResult, { ok: true }>).balanceAfter).toBe(1050);
    expect((r as Extract<BalanceChangeResult, { ok: true }>).balanceBefore).toBe(1000);
  });

  it('扣减成功（不检查透支） → before/after', async () => {
    const db = makeMockDb({ returningBalance: [950] });
    const r = await changeBalance(db, 1, -50);
    expect(r.ok).toBe(true);
    expect((r as Extract<BalanceChangeResult, { ok: true }>).balanceBefore).toBe(1000);
    expect((r as Extract<BalanceChangeResult, { ok: true }>).balanceAfter).toBe(950);
  });

  it('用户不存在 → ok:false reason:not_found', async () => {
    const db = makeMockDb({ returningBalance: [], existsRows: 0 });
    const r = await changeBalance(db, 999, 50);
    expect(r.ok).toBe(false);
    expect((r as Extract<BalanceChangeResult, { ok: false }>).reason).toBe('not_found');
  });

  it('扣减 + checkSufficient + 余额不足 → ok:false reason:insufficient', async () => {
    // update 未命中（返回空）+ exists 命中（用户存在但余额不足）
    const db = makeMockDb({ returningBalance: [], existsRows: 1 });
    const r = await changeBalance(db, 1, -9999, { checkSufficient: true });
    expect(r.ok).toBe(false);
    expect((r as Extract<BalanceChangeResult, { ok: false }>).reason).toBe('insufficient');
  });

  it('扣减 + checkSufficient + 用户不存在 → ok:false reason:not_found', async () => {
    const db = makeMockDb({ returningBalance: [], existsRows: 0 });
    const r = await changeBalance(db, 999, -10, { checkSufficient: true });
    expect(r.ok).toBe(false);
    expect((r as Extract<BalanceChangeResult, { ok: false }>).reason).toBe('not_found');
  });

  it('非有限金额 → ok:false reason:not_found', async () => {
    const db = makeMockDb({});
    const r = await changeBalance(db, 1, Number.NaN);
    expect(r.ok).toBe(false);
  });

  it('浮点金额 → 取整（厘）', async () => {
    const db = makeMockDb({ returningBalance: [1050] });
    const r = await changeBalance(db, 1, 50.7);
    expect(r.ok).toBe(true);
    expect((r as Extract<BalanceChangeResult, { ok: true }>).balanceBefore).toBe(999); // 1050 - 51(rounded)
  });
});
