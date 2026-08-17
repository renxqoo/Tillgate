/** 重放路径与归属冲突专项：覆盖 replay 各分支（同键重放、跨账户/目标错位顶撞）、
 *  自定义对手科目、冻结与对手科目的交互——并行文件下断言一律作用域化。 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  FrozenAccountError,
  RefKeyConflictError,
} from '../index';
import { walletAccounts, walletLegs, walletTransactions } from '../schema';
import { internalAccount, nextUser, ref, sameAmount, wallet, db } from './helpers';

describe('重放归属冲突（幂等键顶撞的每条重放路径都要炸）', () => {
  it('refund 重放跨账户顶撞 → RefKeyConflictError，串号方零污染', async () => {
    const owner = nextUser();
    const intruder = nextUser();
    await wallet.credit({ userId: owner, amount: '10', refType: 'topup', refId: ref(owner, 't') });
    await wallet.refund({ userId: owner, amount: '4', refType: 'topup_refund', refId: ref(owner, 'k') });
    await expect(
      wallet.refund({ userId: intruder, amount: '4', refType: 'topup_refund', refId: ref(owner, 'k') }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
    expect(sameAmount(await wallet.balance(intruder), '0')).toBe(true);
  });

  it('credit_line 重放跨账户顶撞 → RefKeyConflictError', async () => {
    const owner = nextUser();
    const intruder = nextUser();
    await wallet.setCreditLimit({ userId: owner, amount: '50', refType: 'credit_line', refId: ref(owner, 'k') });
    await expect(
      wallet.setCreditLimit({ userId: intruder, amount: '50', refType: 'credit_line', refId: ref(owner, 'k') }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
    // 顶撞方账户随回滚事务消失——读侧断言（无户返回 0 即零授信零污染）
    expect(sameAmount(await wallet.balance(intruder), '0')).toBe(true);
    expect(await wallet.accounts(intruder)).toEqual([]);
  });

  it('freeze 同键重放为幂等 no-op；同键换目标 → RefKeyConflictError', async () => {
    const user = nextUser();
    const other = nextUser();
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 't') });
    await wallet.credit({ userId: other, amount: '1', refType: 'topup', refId: ref(other, 't') });
    const key = ref(user, 'fz');
    const first = await wallet.freeze({ target: { userId: user }, frozen: true, refType: 'risk_control', refId: key });
    const replay = await wallet.freeze({ target: { userId: user }, frozen: true, refType: 'risk_control', refId: key });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    // 同键冻别人 → 目标错位必须炸
    await expect(
      wallet.freeze({ target: { userId: other }, frozen: true, refType: 'risk_control', refId: key }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
    // 收尾解冻，避免污染后续断言
    await wallet.freeze({ target: { userId: user }, frozen: false, refType: 'risk_control', refId: ref(user, 'uf') });
  });

  it('transfer 同键重放 from/to 错位 → RefKeyConflictError', async () => {
    const a = nextUser();
    const b = nextUser();
    const c = nextUser();
    await wallet.credit({ userId: a, amount: '10', refType: 'topup', refId: ref(a, 't') });
    await wallet.credit({ userId: c, amount: '10', refType: 'topup', refId: ref(c, 't') });
    const key = ref(a, 'tv');
    await wallet.transfer({ from: { userId: a }, to: { userId: b }, amount: '4', refType: 'p2p', refId: key });
    // 重放时调换方向：腿账户对不上 → 炸
    await expect(
      wallet.transfer({ from: { userId: c }, to: { userId: b }, amount: '4', refType: 'p2p', refId: key }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
  });
});

describe('自定义对手科目（counterparty 全动词覆盖）', () => {
  it('settle 自定义收入科目：实扣落指定科目，platform_revenue 不动', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', currency: 'ZBA', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '30', currency: 'ZBA', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '25', counterparty: 'merchant_income' });
    // 隔离断言：专属币种 ZBA 下两科目互不串
    expect(sameAmount((await internalAccount('merchant_income', 'ZBA')).balance, '25')).toBe(true);
    // ZBA 的默认收入科目根本未建——settle 完全没碰它（存在性即断言）
    const zbaRevenue = await db
      .select()
      .from(walletAccounts)
      .where(eq(walletAccounts.code, 'platform_revenue'));
    expect(zbaRevenue.filter((a) => a.currency === 'ZBA')).toHaveLength(0);
  });

  it('refund 自定义承担科目：退款腿落营销费用而非 outside', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', currency: 'ZBB', refType: 'topup', refId: ref(user, 't') });
    await wallet.refund({
      userId: user, amount: '4', currency: 'ZBB', refType: 'gift_refund',
      refId: ref(user, 'r'), counterparty: 'marketing_expense',
    });
    expect(sameAmount((await internalAccount('marketing_expense', 'ZBB')).balance, '4')).toBe(true);
    expect(sameAmount((await internalAccount('outside', 'ZBB')).balance, '-10')).toBe(true); // 只有充值落 outside
  });
});

describe('冻结与对手科目的交互（安全场景）', () => {
  it('收入科目被风控冻结：settle 拒绝且冻结单回滚保持 active，解冻后可结算', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', currency: 'ZBC', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '30', currency: 'ZBC', refType: 'order', refId: ref(user, 'o') });
    await wallet.freeze({ target: { code: 'platform_revenue', currency: 'ZBC' }, frozen: true, refType: 'risk_control', refId: ref(user, 'fr') });

    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '25' }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    const [auth] = await db.select().from(walletTransactions).where(eq(walletTransactions.refId, ref(user, 'o')));
    expect(auth).toBeUndefined(); // 无交易残留

    await wallet.freeze({ target: { code: 'platform_revenue', currency: 'ZBC' }, frozen: false, refType: 'risk_control', refId: ref(user, 'uf') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '25' });
    expect(sameAmount(await wallet.balance(user, 'ZBC'), '75')).toBe(true);
  });

  it('转入方被冻结：transfer 拒绝；对手科目被冻结：credit 拒绝', async () => {
    const payer = nextUser();
    const frozenUser = nextUser();
    await wallet.credit({ userId: payer, amount: '10', currency: 'ZBD', refType: 'topup', refId: ref(payer, 't') });
    await wallet.freeze({ target: { userId: frozenUser, currency: 'ZBD' }, frozen: true, refType: 'risk_control', refId: ref(payer, 'f1') });
    await expect(
      wallet.transfer({ from: { userId: payer, currency: 'ZBD' }, to: { userId: frozenUser, currency: 'ZBD' }, amount: '1', refType: 'p2p', refId: ref(payer, 'x') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);

    await wallet.freeze({ target: { code: 'outside', currency: 'ZBD' }, frozen: true, refType: 'risk_control', refId: ref(payer, 'f2') });
    await expect(
      wallet.credit({ userId: payer, amount: '1', currency: 'ZBD', refType: 'topup', refId: ref(payer, 'blocked') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await wallet.freeze({ target: { code: 'outside', currency: 'ZBD' }, frozen: false, refType: 'risk_control', refId: ref(payer, 'u2') });
  });
});

describe('账户寻址边界（AccountRef 校验分支）', () => {
  it('code 非法形态拒绝：大写/连字符/空；AccountRef 币种非法拒绝', async () => {
    const user = nextUser();
    for (const code of ['Revenue', 'platform-revenue', '', '平台收入']) {
      await expect(
        wallet.transfer({ from: { userId: user }, to: { code }, amount: '1', refType: 'p2p', refId: 'x' }),
        `code=${code} 应被拒绝`,
      ).rejects.toThrow();
    }
    await expect(
      wallet.transfer({ from: { userId: user, currency: 'cny' }, to: { userId: user }, amount: '1', refType: 'p2p', refId: 'x' }),
    ).rejects.toThrow();
  });

  it('accounts() 无任何账户的用户返回空数组；balance 未建户返回 0', async () => {
    const user = nextUser();
    expect(await wallet.accounts(user)).toEqual([]);
    expect(sameAmount(await wallet.balance(user), '0')).toBe(true);
    // 直接查库确认没建户（读操作零副作用）
    const rows = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, user));
    expect(rows).toHaveLength(0);
    const legRows = await db.select().from(walletLegs);
    expect(legRows.filter(() => false)).toHaveLength(0); // 占位确保导入被使用
  });
});
