/**
 * 邀请返利集成套件（真 PG）：aff 码纯规则 / 注册归因矩阵 / 双方奖励幂等 /
 * 概览读数（邀请链接、已邀名单、累计佣金只计佣金流水）。
 * 资损不变量：重复归因不二次入账（invitee 唯一 + wallet 自然键双保险）。
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { referrals as referralsTable, users } from '@ai-gateway/db';
import { systemContext } from '@ai-gateway/service';
import { createReferralService } from '../services/referral.service.js';
import {
  commissionAmount,
  decodeAffCode,
  encodeAffCode,
  isPositiveAmount,
  signupBonusRefId,
} from '../domain/referral.js';
import {
  balanceOf,
  db,
  expectAmountEq,
  newUser,
  wallet,
} from './helpers.js';

const ctx = systemContext('cav2-ref');

function buildService(opts: { signupBonus?: string; frontendUrl?: string } = {}) {
  return createReferralService({
    db,
    wallet,
    signupBonus: opts.signupBonus ?? '0',
    commissionRate: '0.1',
    frontendUrl: opts.frontendUrl ?? 'https://console.example.com',
  });
}

describe('aff 码纯规则', () => {
  it('userId ↔ aff 码往返', () => {
    for (const id of [1, 42, 66888, 2 ** 31]) {
      expect(decodeAffCode(encodeAffCode(id))).toBe(id);
    }
    expect(encodeAffCode(42)).toBe('u16'); // 42₁₀ = 16₃₆
    expect(encodeAffCode(42)).toMatch(/^u[0-9a-z]+$/);
  });

  it('畸形码拒绝（空/无u前缀/u0/非数字尾/超长）', () => {
    expect(decodeAffCode('')).toBeNull();
    expect(decodeAffCode('42')).toBeNull();
    expect(decodeAffCode('x42')).toBeNull();
    expect(decodeAffCode('u0')).toBeNull();
    expect(decodeAffCode('u-1')).toBeNull();
    expect(decodeAffCode('u1.5')).toBeNull();
    expect(decodeAffCode(`u${'9'.repeat(40)}`)).toBeNull();
  });

  it('自然键与金额规则', () => {
    expect(signupBonusRefId(7, 'inviter')).toBe('referral-signup:7:inviter');
    expect(commissionAmount('10', '0.1')).toBe('1');
    expect(commissionAmount('10.5', '0.05')).toBe('0.525');
    expect(isPositiveAmount('0.001')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('-1')).toBe(false);
    expect(isPositiveAmount('garbage')).toBe(false); // Decimal 构造抛错 → false
  });
});

describe('注册归因（applyReferral）', () => {
  it('happy path：建关系 + 双方各得奖励', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    const service = buildService({ signupBonus: '3' });
    const result = await service.applyReferral(ctx, {
      inviteeId: invitee.id,
      affCode: encodeAffCode(inviter.id),
    });
    expect(result).toEqual({ applied: true });
    expectAmountEq(await balanceOf(inviter.id), '3');
    expectAmountEq(await balanceOf(invitee.id), '3');
    const [row] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.inviteeUserId, invitee.id));
    expect(row?.inviterUserId).toBe(inviter.id);
    expect(row?.status).toBe(0);
  });

  it('重复归因：already_referred，余额不二次入账', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    const service = buildService({ signupBonus: '3' });
    await service.applyReferral(ctx, { inviteeId: invitee.id, affCode: encodeAffCode(inviter.id) });
    const again = await service.applyReferral(ctx, {
      inviteeId: invitee.id,
      affCode: encodeAffCode(inviter.id),
    });
    expect(again).toEqual({ applied: false, reason: 'already_referred' });
    expectAmountEq(await balanceOf(inviter.id), '3');
    expectAmountEq(await balanceOf(invitee.id), '3');
  });

  it('畸形码 / 自邀 / 封禁邀请人 → 各自拒绝且零入账', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    const service = buildService({ signupBonus: '3' });

    expect(await service.applyReferral(ctx, { inviteeId: invitee.id, affCode: 'zzz' })).toEqual({
      applied: false,
      reason: 'invalid_code',
    });
    expect(
      await service.applyReferral(ctx, { inviteeId: invitee.id, affCode: encodeAffCode(invitee.id) }),
    ).toEqual({ applied: false, reason: 'self_invite' });

    const banned = await newUser();
    await db.update(users).set({ status: 1 }).where(eq(users.id, banned.id));
    const fresh = await newUser();
    const bannedResult = await service.applyReferral(ctx, {
      inviteeId: fresh.id,
      affCode: encodeAffCode(banned.id),
    });
    expect(bannedResult).toEqual({ applied: false, reason: 'inviter_not_found' });
    expectAmountEq(await balanceOf(banned.id), '0');
    expectAmountEq(await balanceOf(fresh.id), '0');

    expectAmountEq(await balanceOf(inviter.id), '0');
    expectAmountEq(await balanceOf(invitee.id), '0');
  });

  it('奖励关闭（signupBonus=0）：建关系零入账', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    const service = buildService();
    expect(
      await service.applyReferral(ctx, { inviteeId: invitee.id, affCode: encodeAffCode(inviter.id) }),
    ).toEqual({ applied: true });
    expectAmountEq(await balanceOf(invitee.id), '0');
  });

  it('任一侧奖励失败时，关系与已发出的另一侧奖励一并回滚', async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    let calls = 0;
    const brokenWallet = {
      ...wallet,
      credit: async (...args: Parameters<typeof wallet.credit>) => {
        calls += 1;
        if (calls === 2) throw new Error('wallet down');
        return wallet.credit(...args);
      },
    } as unknown as typeof wallet;
    const service = createReferralService({
      db,
      wallet: brokenWallet,
      signupBonus: '3',
      commissionRate: '0.1',
      frontendUrl: 'https://console.example.com',
    });
    await expect(
      service.applyReferral(ctx, { inviteeId: invitee.id, affCode: encodeAffCode(inviter.id) }),
    ).rejects.toThrow('wallet down');
    const [row] = await db
      .select()
      .from(referralsTable)
      .where(eq(referralsTable.inviteeUserId, invitee.id));
    expect(row).toBeUndefined();
    expectAmountEq(await balanceOf(inviter.id), '0');
    expectAmountEq(await balanceOf(invitee.id), '0');
  });
});

describe('邀请概览（overview）', () => {
  it('aff 码/链接/名单/累计佣金（只计佣金流水，不含注册奖励）', async () => {
    const inviter = await newUser();
    const service = buildService({ signupBonus: '3', frontendUrl: 'https://console.example.com' });
    const a = await newUser();
    const b = await newUser();
    await service.applyReferral(ctx, { inviteeId: a.id, affCode: encodeAffCode(inviter.id) });
    await service.applyReferral(ctx, { inviteeId: b.id, affCode: encodeAffCode(inviter.id) });

    // 模拟 worker 日结的两笔佣金 + 一笔注册奖励（不应计入佣金合计）
    await wallet.credit(ctx, {
      userId: inviter.id,
      amount: '1.25',
      refType: 'referral',
      refId: `referral-commission:${inviter.id}:20260817`,
      memo: '佣金',
    });
    await wallet.credit(ctx, {
      userId: inviter.id,
      amount: '0.75',
      refType: 'referral',
      refId: `referral-commission:${inviter.id}:20260818`,
      memo: '佣金',
    });

    const view = await service.overview(ctx, inviter.id);
    expect(view.affCode).toBe(encodeAffCode(inviter.id));
    expect(view.inviteUrl).toBe(`https://console.example.com/register?aff=${view.affCode}`);
    expect(view.signupBonus).toBe('3');
    expect(view.commissionRate).toBe('0.1');
    expect(view.invited.map((r) => r.inviteeId).toSorted((x, y) => x - y)).toEqual(
      [a.id, b.id].toSorted((x, y) => x - y),
    );
    expect(view.invited.every((r) => r.status === 0 && r.createdAt != null)).toBe(true);
    expectAmountEq(view.totalCommission, '2');
  });

  it('无邀请记录：空名单零佣金', async () => {
    const loner = await newUser();
    const view = await buildService().overview(ctx, loner.id);
    expect(view.invited).toEqual([]);
    expectAmountEq(view.totalCommission, '0');
  });
});
