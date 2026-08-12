import { describe, expect, it } from 'vitest';
import { changeBalance, type BalanceChangeResult, unfreezeIfBadDebt } from './balance.js';

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
  /** update().returning() 返回的余额行（空 = 未更新）；余额为 string（DB numeric） */
  returningBalance?: string[];
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

describe('changeBalance 逻辑分支（元 + decimal）', () => {
  it('普通变更成功 → ok:true + before/after（string）', async () => {
    const db = makeMockDb({ returningBalance: ['1.05'] });
    const r = await changeBalance(db, 1, '0.05');
    expect(r.ok).toBe(true);
    const ok = r as Extract<BalanceChangeResult, { ok: true }>;
    expect(ok.balanceAfter).toBe('1.05');
    expect(ok.balanceBefore).toBe('1'); // 1.05 - 0.05 = 1
  });

  it('扣减成功（不检查透支） → before/after', async () => {
    const db = makeMockDb({ returningBalance: ['0.95'] });
    const r = await changeBalance(db, 1, '-0.05');
    expect(r.ok).toBe(true);
    const ok = r as Extract<BalanceChangeResult, { ok: true }>;
    expect(ok.balanceBefore).toBe('1'); // 0.95 - (-0.05) = 1
    expect(ok.balanceAfter).toBe('0.95');
  });

  it('用户不存在 → ok:false reason:not_found', async () => {
    const db = makeMockDb({ returningBalance: [], existsRows: 0 });
    const r = await changeBalance(db, 999, '0.05');
    expect(r.ok).toBe(false);
    expect((r as Extract<BalanceChangeResult, { ok: false }>).reason).toBe('not_found');
  });

  it('扣减 + checkSufficient + 余额不足 → ok:false reason:insufficient', async () => {
    const db = makeMockDb({ returningBalance: [], existsRows: 1 });
    const r = await changeBalance(db, 1, '-99.99', { checkSufficient: true });
    expect(r.ok).toBe(false);
    expect((r as Extract<BalanceChangeResult, { ok: false }>).reason).toBe('insufficient');
  });

  it('扣减 + checkSufficient + 用户不存在 → ok:false reason:not_found', async () => {
    const db = makeMockDb({ returningBalance: [], existsRows: 0 });
    const r = await changeBalance(db, 999, '-0.1', { checkSufficient: true });
    expect(r.ok).toBe(false);
    expect((r as Extract<BalanceChangeResult, { ok: false }>).reason).toBe('not_found');
  });

  it('非数字金额 → ok:false reason:not_found', async () => {
    const db = makeMockDb({});
    const r = await changeBalance(db, 1, 'not-a-number');
    expect(r.ok).toBe(false);
  });

  it('小数金额 → 全精度（不取整，重构后账本永不 round）', async () => {
    const db = makeMockDb({ returningBalance: ['1.05'] });
    const r = await changeBalance(db, 1, '0.057');
    expect(r.ok).toBe(true);
    const ok = r as Extract<BalanceChangeResult, { ok: true }>;
    // balanceBefore = 1.05 - 0.057 = 0.993（全精度，不 round 成厘）
    expect(ok.balanceBefore).toBe('0.993');
  });
});

describe('B-1: unfreezeIfBadDebt 只清坏账冻结（不动 manual_review 等）', () => {
  it('unfreezeIfBadDebt 是函数且可正常调用（不抛错）', async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
    } as never;
    // 不抛错即通过（WHERE 条件的 bad_debt 精确性由源码审查 + 集成测试保证）
    await expect(unfreezeIfBadDebt(db, 1)).resolves.toBeUndefined();
  });

  it('源码 WHERE 条件包含 freeze_reason = bad_debt（防回退）', async () => {
    // balance.ts 已抽到 @ai-gateway/billing，读 billing 包源码验证 WHERE 条件
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../../../packages/billing/src/balance.ts', import.meta.url)),
      'utf8',
    );
    const start = src.indexOf('export async function unfreezeIfBadDebt');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, start + 500);
    expect(body).toMatch(/bad_debt/);
    expect(body).not.toMatch(/freezeReason.*is not null/i);
  });
});
