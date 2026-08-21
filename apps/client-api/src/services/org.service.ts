/**
 * 组织服务（用户面编排）：我的组织 / 详情 / 邀请（席位+pending 上限）/ 撤销 /
 * 接受（事务内锁订阅行防 TOCTOU + 邀请原子翻转）/ 成员日限与移除。
 * SQL 全部走 org.repo 的原子方法。
 */
import { Decimal } from '@ai-gateway/domain';
import { randomUUID } from 'node:crypto';
import type { Db } from '@ai-gateway/repository';
import { createRepositories, type Repositories } from '@ai-gateway/repository';
import type { RunContext } from '@ai-gateway/service';
import { AppError } from '../http/error-map.js';
import { recordAudit } from '@ai-gateway/http';

/** 邀请有效期（7 天）；待接受上限 = min(max(剩余席位,1) × 2, 20) */
const INVITATION_TTL_MS = 7 * 86_400_000;

export interface OrgListItem {
  orgId: number;
  name: string;
  role: string;
  subscriptionId: number | null;
  planName: string | null;
  quantity: number | null;
  quotaAmount: string | null;
  usedAmount: string | null;
  reservedAmount: string | null;
}

export interface OrgService {
  listMyOrgs(ctx: RunContext, userId: number): Promise<OrgListItem[]>;
  orgDetail(
    ctx: RunContext,
    userId: number,
    orgId: number,
  ): Promise<{
    org: { id: number; name: string };
    members: Awaited<ReturnType<Repositories['org']['listMembers']>>;
    invitations: Awaited<ReturnType<Repositories['org']['listPendingInvitations']>>;
  }>;
  invite(ctx: RunContext, userId: number, orgId: number, email: string): Promise<{ invitationId: number; token: string }>;
  revokeInvitation(ctx: RunContext, userId: number, orgId: number, invitationId: number): Promise<void>;
  acceptInvitation(ctx: RunContext, userId: number, token: string): Promise<{ orgId: number }>;
  patchMember(
    ctx: RunContext,
    userId: number,
    orgId: number,
    memberUserId: number,
    patch: { dailySpendLimit?: string | null; monthlyQuota?: string | null },
  ): Promise<void>;
  removeMember(ctx: RunContext, userId: number, orgId: number, memberUserId: number): Promise<void>;
}

type OrgTx = Parameters<Parameters<Db['transaction']>[0]>[0];

const asUser = (db: Db, ctx: RunContext, userId: number) => ({
  db,
  ...ctx,
  actor: { kind: 'user' as const, id: userId },
});

const inUserTx = (ctx: RunContext, userId: number, tx: OrgTx) => ({
  db: tx,
  ...ctx,
  actor: { kind: 'user' as const, id: userId },
});

export function createOrgService(deps: { db: Db; repos?: Repositories; clock?: () => Date }): OrgService {
  const { db } = deps;
  const repos = deps.repos ?? createRepositories();
  const clock = deps.clock ?? (() => new Date());

  /** owner 校验（非 owner 403） */
  async function requireOwner(
    c: Parameters<Repositories['org']['findActiveMembership']>[0],
    orgId: number,
    userId: number,
  ) {
    const membership = await repos.org.findActiveMembership(c, { orgId, userId });
    if (!membership || membership.role !== 'owner') {
      throw new AppError(403, 'org_forbidden', 'No permission to operate this organization (owner only)');
    }
    return membership;
  }

  return {
    async listMyOrgs(ctx, userId) {
      const runCtx = asUser(db, ctx, userId);
      const memberships = await repos.org.listMembershipsForUser(runCtx, userId);
      const now = clock();
      return Promise.all(
        memberships.map(async (m) => {
          const sub = await repos.subscription.findOrgSubscriptionDetail(runCtx, { orgId: m.orgId, now });
          const remainingAmount =
            sub != null
              ? Decimal.max(new Decimal(sub.quotaAmount).minus(sub.usedAmount).minus(sub.reservedAmount), new Decimal(0)).toString()
              : '0';
          return {
            orgId: m.orgId,
            name: m.name,
            role: m.role,
            subscriptionId: sub?.id ?? null,
            planName: sub?.planName ?? null,
            quantity: sub?.quantity ?? null,
            quotaAmount: sub?.quotaAmount ?? null,
            usedAmount: sub?.usedAmount ?? null,
            reservedAmount: sub?.reservedAmount ?? null,
            remainingAmount,
          };
        }),
      );
    },

    async orgDetail(ctx, userId, orgId) {
      const runCtx = asUser(db, ctx, userId);
      const membership = await repos.org.findActiveMembership(runCtx, { orgId, userId });
      if (!membership) throw new AppError(404, 'org_not_found', 'Organization not found or you are not a member');
      const org = await repos.org.findOrg(runCtx, orgId);
      if (!org) throw new AppError(404, 'org_not_found', 'Organization not found or you are not a member');
      const members = await repos.org.listMembers(runCtx, orgId);
      // 待接受邀请仅 owner 可见；不含 token（token 只在创建时下发一次）
      const invitations =
        membership.role === 'owner'
          ? await repos.org.listPendingInvitations(runCtx, { orgId, now: clock() })
          : [];
      return { org, members, invitations };
    },

    async invite(ctx, userId, orgId, email) {
      const runCtx = asUser(db, ctx, userId);
      await requireOwner(runCtx, orgId, userId);
      const now = clock();

      const sub = await repos.org.findActiveOrgSubscription(runCtx, { orgId, now });
      if (!sub) throw new AppError(409, 'org_no_subscription', 'Organization has no active subscription, cannot invite');

      const activeCount = await repos.org.countActiveMembers(runCtx, orgId);
      if (activeCount >= sub.quantity) {
        throw new AppError(409, 'seats_full', 'All seats are taken, cannot invite more members');
      }
      // 待接受上限：防脚本化刷邀请行（accept 才校验席位，创建面无上限可无限堆 pending）
      const pendingCap = Math.min(Math.max(sub.quantity - activeCount, 1) * 2, 20);
      const pending = await repos.org.countPendingInvitations(runCtx, { orgId, now });
      if (pending >= pendingCap) {
        throw new AppError(409, 'invitations_full', 'Too many pending invitations, please revoke some or wait for them to be processed');
      }

      const inserted = await db.transaction((tx) =>
        repos.org.insertInvitation(inUserTx(ctx, userId, tx), {
          orgId,
          email: email.toLowerCase(),
          token: randomUUID().replace(/-/g, ''),
          invitedByUserId: userId,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        }),
      );
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'org.invite',
        targetType: 'org',
        targetId: orgId,
        detail: { invitationId: inserted.id, invitedEmail: email },
      }).catch(() => undefined);
      return { invitationId: inserted.id, token: inserted.token };
    },

    async revokeInvitation(ctx, userId, orgId, invitationId) {
      const runCtx = asUser(db, ctx, userId);
      await requireOwner(runCtx, orgId, userId);
      const revoked = await db.transaction(async (tx) =>
        repos.org.revokeInvitation(inUserTx(ctx, userId, tx), { orgId, invitationId }),
      );
      if (!revoked) throw new AppError(404, 'invitation_not_found', 'Invitation not found or already processed');
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'org.invite_revoke',
        targetType: 'org',
        targetId: orgId,
        detail: { invitationId },
      }).catch(() => undefined);
    },

    async acceptInvitation(ctx, userId, token) {
      const runCtx = asUser(db, ctx, userId);
      const user = await repos.userAccount.findById(runCtx, userId);
      if (!user) throw new AppError(401, 'unauthorized', 'Account not found');

      const inv = await repos.org.findInvitationByToken(runCtx, token);
      // 快路径分型提示（权威校验在事务内的原子翻转）
      if (!inv) throw new AppError(404, 'invitation_invalid', 'Invitation link is invalid or expired');
      if (inv.status === 2) throw new AppError(409, 'invitation_revoked', 'Invitation has been revoked');
      if (inv.status === 1) throw new AppError(409, 'invitation_already_accepted', 'Invitation has already been accepted');
      if (inv.expiresAt <= clock()) throw new AppError(410, 'invitation_expired', 'Invitation has expired');
      // 登录账号须与邀请 email 一致（无 email 时按 subject 兜底）
      const userEmail = user.email?.toLowerCase();
      if (userEmail !== inv.email.toLowerCase() && user.subject !== inv.email) {
        throw new AppError(403, 'invitation_email_mismatch', 'Logged-in account does not match the invited email');
      }

      await db.transaction(async (tx) => {
        const c = inUserTx(ctx, userId, tx);
        // 锁订阅行（串行化席位校验）+ 复检席位
        const sub = await repos.org.lockActiveOrgSubscription(c, { orgId: inv.orgId, now: clock() });
        if (!sub) throw new AppError(409, 'org_no_subscription', 'Organization subscription is no longer active');
        const activeCount = await repos.org.countActiveMembers(c, inv.orgId);
        if (activeCount >= sub.quantity) {
          throw new AppError(409, 'seats_full', 'All seats are taken');
        }
        await repos.org.insertOrReviveMember(c, { orgId: inv.orgId, userId, role: 'member' });
        // 原子翻转：0 行 = 与并发撤销/接受/过期竞态 → 回滚（成员插入一并撤销）
        const flipped = await repos.org.acceptInvitation(c, { invitationId: inv.id, userId, now: clock() });
        if (!flipped) {
          throw new AppError(409, 'invitation_invalid', 'Invitation was processed concurrently, please refresh and retry');
        }
      });
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'org.invite_accept',
        targetType: 'org',
        targetId: inv.orgId,
      }).catch(() => undefined);
      return { orgId: inv.orgId };
    },

    async patchMember(ctx, userId, orgId, memberUserId, patch) {
      const runCtx = asUser(db, ctx, userId);
      await requireOwner(runCtx, orgId, userId);
      const patched = await db.transaction(async (tx) =>
        repos.org.patchMember(inUserTx(ctx, userId, tx), { orgId, userId: memberUserId, patch }),
      );
      if (!patched) throw new AppError(404, 'org_member_not_found', 'Member not found');
    },

    async removeMember(ctx, userId, orgId, memberUserId) {
      const runCtx = asUser(db, ctx, userId);
      await requireOwner(runCtx, orgId, userId);
      if (memberUserId === userId) {
        throw new AppError(409, 'org_cannot_remove_owner', 'Owner cannot be removed');
      }
      const removed = await db.transaction(async (tx) =>
        repos.org.removeMember(inUserTx(ctx, userId, tx), { orgId, userId: memberUserId }),
      );
      if (!removed) throw new AppError(404, 'org_member_not_found', 'Member not found');
      await recordAudit(deps.db, {
        actor: 'user',
        action: 'org.member_remove',
        targetType: 'org',
        targetId: orgId,
        detail: { memberUserId },
      }).catch(() => undefined);
    },
  };
}
