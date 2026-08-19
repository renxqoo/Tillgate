/**
 * 邀请返利服务：注册归因（applyReferral——尽力而为，绝不阻断注册）+
 * 邀请概览（aff 码/链接、已邀名单、累计佣金）。
 *
 * 资损不变量：
 *   - 一人只能被邀一次（referrals.invitee_uq 唯一索引兜底并发）
 *   - 奖励/佣金入账幂等 = wallet 自然键（refType 'referral' + refId + kind credit 唯一）
 *   - 邀请人封禁/不存在 → 建关系不派奖（关系可追溯，钱不落坏人账）
 */
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import type { RunContext, WalletApi } from '@ai-gateway/service';
import {
  decodeAffCode,
  encodeAffCode,
  signupBonusRefId,
} from '../domain/referral.js';

export interface ReferralServiceDeps {
  db: Db;
  wallet: WalletApi;
  repos?: Repositories;
  /** 双方注册奖励（元，字符串；'0' = 关闭） */
  signupBonus: string;
  /** 佣金比例（0–1；worker 日结同值） */
  commissionRate: number;
  /** 前端基地址（拼邀请链接） */
  frontendUrl: string;
}

export type ApplyReferralResult =
  | { applied: true }
  | { applied: false; reason: 'invalid_code' | 'self_invite' | 'already_referred' | 'inviter_not_found' };

export interface InviteOverview {
  affCode: string;
  inviteUrl: string;
  signupBonus: number;
  commissionRate: number;
  invited: Array<{ inviteeId: number; inviteeName: string | null; createdAt: string; status: number }>;
  totalCommission: string;
}

/** 佣金 refId 前缀（区分注册奖励与日结佣金两类 'referral' 流水） */
const COMMISSION_REF_PREFIX = 'referral-commission:';

const sys = (ctx: RunContext): RunContext => ({ ...ctx, actor: { kind: 'system' } });

export function createReferralService(deps: ReferralServiceDeps) {
  const { db, wallet } = deps;
  const repos = deps.repos ?? createRepositories();
  const repo = (ctx: RunContext) => ({ db, ...sys(ctx) });
  const signupBonus = new Decimal(deps.signupBonus);

  async function applyReferral(
    ctx: RunContext,
    input: { inviteeId: number; affCode: string },
  ): Promise<ApplyReferralResult> {
    const inviterId = decodeAffCode(input.affCode.trim());
    if (inviterId === null) return { applied: false, reason: 'invalid_code' };
    if (inviterId === input.inviteeId) return { applied: false, reason: 'self_invite' };

    const inserted = await repos.referral.insertReferral(repo(ctx), {
      inviterUserId: inviterId,
      inviteeUserId: input.inviteeId,
    });
    if (!inserted) return { applied: false, reason: 'already_referred' };
    if (!(await repos.referral.inviterActive(repo(ctx), inviterId))) {
      return { applied: false, reason: 'inviter_not_found' };
    }

    if (signupBonus.greaterThan(0)) {
      // 双方奖励：wallet 自然键幂等；失败不回滚注册（键可补发，账不受损）
      const base = sys(ctx);
      await wallet
        .credit(base, {
          userId: inviterId,
          amount: deps.signupBonus,
          refType: 'referral',
          refId: signupBonusRefId(input.inviteeId, 'inviter'),
          memo: `邀请注册奖励（邀请人）+${deps.signupBonus}`,
        })
        .catch(() => undefined);
      await wallet
        .credit(base, {
          userId: input.inviteeId,
          amount: deps.signupBonus,
          refType: 'referral',
          refId: signupBonusRefId(input.inviteeId, 'invitee'),
          memo: `受邀注册奖励 +${deps.signupBonus}`,
        })
        .catch(() => undefined);
    }
    return { applied: true };
  }

  /** 累计佣金：wallet 仓储聚合读（refType 'referral' + 佣金 refId 前缀的正向腿求和） */
  async function totalCommission(ctx: RunContext, userId: number): Promise<string> {
    return repos.wallet.sumCreditedByRefPrefix(repo(ctx), {
      userId,
      refType: 'referral',
      refIdPrefix: COMMISSION_REF_PREFIX,
    });
  }

  async function overview(ctx: RunContext, userId: number): Promise<InviteOverview> {
    const rows = await repos.referral.listInviteesByInviter(repo(ctx), userId);
    const affCode = encodeAffCode(userId);
    return {
      affCode,
      inviteUrl: `${deps.frontendUrl}/register?aff=${affCode}`,
      signupBonus: signupBonus.toNumber(),
      commissionRate: deps.commissionRate,
      invited: rows.map((r) => ({
        inviteeId: r.inviteeUserId,
        inviteeName: r.inviteeName ?? null,
        createdAt: r.createdAt.toISOString(),
        status: r.status,
      })),
      totalCommission: await totalCommission(ctx, userId),
    };
  }

  return { applyReferral, overview };
}

export type ReferralService = ReturnType<typeof createReferralService>;
