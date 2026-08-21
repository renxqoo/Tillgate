/**
 * 兑换码集成套件（真 PG）：核销入账一笔事务 + CAS 并发唯一赢家 +
 * 错误语义三分（无效/已用/过期）。资损不变量：同码 N 方并发只有一笔入账。
 */
import { describe, expect, it } from 'vitest';
import { systemContext } from '@ai-gateway/service';
import { createRedeemService } from '../services/redeem.service.js';
import {
  balanceOf,
  db,
  neverHitCounter,
  expectAmountEq,
  newRedeemCode,
  newUser,
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-redeem');
const redeem = createRedeemService({ db, wallet, limiter: neverHitCounter, perMinuteLimit: 10 });

/** 带频率闸的实例（429 语义测试） */
const throttled = (() => {
  let hits = 0;
  return createRedeemService({
    db,
    wallet,
    limiter: { hit: async () => ++hits },
    perMinuteLimit: 3,
  });
})();

describe('兑换码', () => {
  it('happy path：入账批次面额 + 流水锚 refType=redeem/refId=code:{id}', async () => {
    const account = await newUser();
    const code = await newRedeemCode({ amount: '12.5' });
    const result = await redeem.redeem(ctx, account.id, { code: code.plaintext });
    expectAmountEq(result.amount, '12.5');
    expectAmountEq(await balanceOf(account.id), '12.5');
    const legs = await wallet.statement(ctx, { userId: account.id, limit: 10 });
    const leg = legs.find((l) => l.refType === 'redeem');
    expect(leg?.refId).toBe(`code:${code.codeId}`);
    expect(leg?.transactionKind).toBe('credit');
  });

  it('同码二次兑换 → 409 已用；余额不重复入账', async () => {
    const account = await newUser();
    const other = await newUser();
    const code = await newRedeemCode({ amount: '3' });
    await redeem.redeem(ctx, account.id, { code: code.plaintext });
    await expect(redeem.redeem(ctx, other.id, { code: code.plaintext })).rejects.toMatchObject({
      status: 409,
      code: 'code_already_used',
    });
    expectAmountEq(await balanceOf(other.id), '0');
    expectAmountEq(await balanceOf(account.id), '3');
  });

  it('无效码 → 404；过期码 → 410', async () => {
    const account = await newUser();
    await expect(redeem.redeem(ctx, account.id, { code: 'not-a-real-code' })).rejects.toMatchObject({
      status: 404,
      code: 'invalid_code',
    });
    const expired = await newRedeemCode({
      amount: '5',
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(redeem.redeem(ctx, account.id, { code: expired.plaintext })).rejects.toMatchObject({
      status: 410,
      code: 'code_expired',
    });
    expectAmountEq(await balanceOf(account.id), '0');
  });

  it('并发同码：恰好一方入账一次（CAS 唯一赢家）', async () => {
    const a = await newUser();
    const b = await newUser();
    const code = await newRedeemCode({ amount: '8' });
    const results = await Promise.allSettled([
      redeem.redeem(ctx, a.id, { code: code.plaintext }),
      redeem.redeem(ctx, b.id, { code: code.plaintext }),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const rejects = results.filter((r) => r.status === 'rejected');
    expect(wins.length).toBe(1);
    expect(rejects.length).toBe(1);
    // 总入账恒等于面额——无论谁赢
    const sum = Number(await balanceOf(a.id)) + Number(await balanceOf(b.id));
    expect(sum).toBe(8);
    // 输家收到结构化拒绝（已用，而非 500）
    const reason = (rejects[0] as PromiseRejectedResult).reason as { code?: string };
    expect(reason.code).toBe('code_already_used');
  });
});

describe('频率闸与历史', () => {
  it('每分钟超限 → 429（防暴力猜码）', async () => {
    const account = await newUser();
    // 3 次尝试（码可无效——计数在前，猜码本身就该被计）
    for (let i = 0; i < 3; i++) {
      await throttled.redeem(ctx, account.id, { code: `guess-${i}` }).catch(() => undefined);
    }
    await expect(throttled.redeem(ctx, account.id, { code: 'guess-4' })).rejects.toMatchObject({
      status: 429,
      code: 'redeem_rate_limited',
    });
  });

  it('历史只返回本人已兑换记录（面额/批次名），用户隔离', async () => {
    const a = await newUser();
    const b = await newUser();
    const codeA = await newRedeemCode({ amount: '7' });
    const codeB = await newRedeemCode({ amount: '9' });
    await redeem.redeem(ctx, a.id, { code: codeA.plaintext });
    await redeem.redeem(ctx, b.id, { code: codeB.plaintext });

    const historyA = await redeem.history(ctx, a.id, { page: 1, limit: 10 });
    expect(historyA.length).toBe(1);
    expect(historyA[0]!.codeId).toBe(codeA.codeId);
    expectAmountEq(historyA[0]!.amount, '7');
    expect(historyA[0]!.batchName).toBeTruthy();
    expect(historyA[0]!.usedAt).not.toBeNull();
  });
});
