/**
 * 邀请返利服务：注册归因（applyReferral——尽力而为，绝不阻断注册）+
 * 邀请概览（aff 码/链接、已邀名单、累计佣金）。
 *
 * 资损不变量：
 *   - 一人只能被邀一次（referrals.invitee_uq 唯一索引兜底并发）
 *   - 奖励/佣金入账幂等 = wallet 自然键（refType 'referral' + refId + kind credit 唯一）
 *   - 关系与双方注册奖励共用一个数据库事务，禁止只发一边或只落关系
 *   - 邀请人封禁/不存在 → 不建关系、不派奖
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
  signupBonus: string | (() => Promise<string>);
  /** 佣金比例（0–1；worker 日结同值） */
  commissionRate: string | (() => Promise<string>);
  /** 前端基地址（拼邀请链接） */
  frontendUrl: string;
}

export type ApplyReferralResult =
  | { applied: true }
  | { applied: false; reason: 'invalid_code' | 'self_invite' | 'already_referred' | 'inviter_not_found' };

export interface InviteOverview {
  affCode: string;
  inviteUrl: string;
  signupBonus: string | (() => Promise<string>);
  commissionRate: string | (() => Promise<string>);
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

  async function applyReferral(
    ctx: RunContext,
    input: { inviteeId: number; affCode: string },
  ): Promise<ApplyReferralResult> {
    const inviterId = decodeAffCode(input.affCode.trim());
    if (inviterId === null) return { applied: false, reason: 'invalid_code' };
    if (inviterId === input.inviteeId) return { applied: false, reason: 'self_invite' };
    // 营销参数每动作读现值（DB 化）：同一注册周期内改值不影响已开始的事务
    const signupBonusRaw = await resolveParam(deps.signupBonus);
    const signupBonus = new Decimal(signupBonusRaw);

    return db.transaction(async (tx) => {
      const txRepo = { db: tx, ...sys(ctx) };
      if (!(await repos.referral.inviterActive(txRepo, inviterId))) {
        return { applied: false, reason: 'inviter_not_found' } as const;
      }
      const inserted = await repos.referral.insertReferral(txRepo, {
        inviterUserId: inviterId,
        inviteeUserId: input.inviteeId,
      });
      if (!inserted) return { applied: false, reason: 'already_referred' } as const;

      if (signupBonus.greaterThan(0)) {
        const base = sys(ctx);
        await wallet.credit(base, {
          userId: inviterId,
          amount: signupBonusRaw,
          refType: 'referral',
          refId: signupBonusRefId(input.inviteeId, 'inviter'),
          memo: `邀请注册奖励（邀请人）+${signupBonusRaw}`,
          tx,
        });
        await wallet.credit(base, {
          userId: input.inviteeId,
          amount: signupBonusRaw,
          refType: 'referral',
          refId: signupBonusRefId(input.inviteeId, 'invitee'),
          memo: `受邀注册奖励 +${signupBonusRaw}`,
          tx,
        });
      }
      return { applied: true } as const;
    });
  }

  /** 累计佣金：wallet 仓储聚合读（refType 'referral' + 佣金 refId 前缀的正向腿求和） */
  async function totalCommission(ctx: RunContext, userId: number): Promise<string> {
    return repos.wallet.sumCreditedByRefPrefix(repo(ctx), {
      userId,
      refType: 'referral',
      refIdPrefix: COMMISSION_REF_PREFIX,
    });
  }

  /** 功能开关（marketing_settings 现值）：两项激励任一 > 0 即开启——全 0 时 C 端隐藏入口与页面 */
  async function config(_ctx: import('@ai-gateway/service').RunContext, _userId: number): Promise<{ enabled: boolean; signupBonus: string; commissionRate: string }> {
    const [bonus, rate] = [await resolveParam(deps.signupBonus), await resolveParam(deps.commissionRate)];
    return {
      enabled: new Decimal(bonus).greaterThan(0) || new Decimal(rate).greaterThan(0),
      signupBonus: bonus,
      commissionRate: rate,
    };
  }

  async function overview(ctx: RunContext, userId: number): Promise<InviteOverview> {
    const rows = await repos.referral.listInviteesByInviter(repo(ctx), userId);
    const affCode = encodeAffCode(userId);
    return {
      affCode,
      inviteUrl: `${deps.frontendUrl}/register?aff=${affCode}`,
      signupBonus: await resolveParam(deps.signupBonus),
      commissionRate: await resolveParam(deps.commissionRate),
      invited: rows.map((r) => ({
        inviteeId: r.inviteeUserId,
        inviteeName: r.inviteeName ?? null,
        createdAt: r.createdAt.toISOString(),
        status: r.status,
      })),
      totalCommission: await totalCommission(ctx, userId),
    };
  }

  return { applyReferral, overview, config };
}

export type ReferralService = ReturnType<typeof createReferralService>;

/** 营销参数解析（2026-08-21 DB 化）：string=测试固定值 / fn=每动作读 marketing_settings 现值 */
async function resolveParam(source: string | (() => Promise<string>)): Promise<string> {
  return typeof source === 'function' ? source() : source;
}
