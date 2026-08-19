/**
 * 组织聚合仓储：组织/成员/邀请。席位不变量（active 成员数 ≤ 订阅 quantity）
 * 与邀请翻转的原子性都在方法边界（CAS / FOR UPDATE 由用例层在事务内编排）。
 */
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { DbTx } from '@ai-gateway/db';
import { organizations, orgInvitations, orgMembers, userSubscriptions, users } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

function tx(c: RepoContext): DbTx {
  return c.db as DbTx;
}

export interface OrgMembershipRow {
  orgId: number;
  userId: number;
  role: string;
  status: number;
  dailySpendLimit: string | null;
  monthlyQuota: string | null;
}

export interface InvitationRow {
  id: number;
  orgId: number;
  email: string;
  status: number;
  expiresAt: Date;
}

/** 组织仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class OrgRepository {
  /** 组织基本信息 */
  async findOrg(c: RepoContext, orgId: number): Promise<{ id: number; name: string } | null> {
    const [row] = await c.db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return row ?? null;
  }

  /** 建组织 + owner 成员（同事务内与订阅共生死；调用方包在购买事务里） */
  async insertOrgWithOwner(
    c: RepoContext,
    input: { name: string; ownerUserId: number },
  ): Promise<number> {
    const [org] = await tx(c)
      .insert(organizations)
      .values({ name: input.name, ownerUserId: input.ownerUserId })
      .returning({ id: organizations.id });
    await tx(c).insert(orgMembers).values({
      orgId: org!.id,
      userId: input.ownerUserId,
      role: 'owner',
      status: 0,
    });
    return org!.id;
  }

  /** 有效成员行（status=0；无行 = 不是成员/已移除） */
  async findActiveMembership(
    c: RepoContext,
    input: { orgId: number; userId: number },
  ): Promise<OrgMembershipRow | null> {
    const [row] = await c.db
      .select({
        orgId: orgMembers.orgId,
        userId: orgMembers.userId,
        role: orgMembers.role,
        status: orgMembers.status,
        dailySpendLimit: orgMembers.dailySpendLimit,
        monthlyQuota: orgMembers.monthlyQuota,
      })
      .from(orgMembers)
      .where(
        and(
          eq(orgMembers.orgId, input.orgId),
          eq(orgMembers.userId, input.userId),
          eq(orgMembers.status, 0),
        ),
      );
    return row ?? null;
  }

  /** 组织的有效订阅（org_id 关联；FOR UPDATE 变体用于接受邀请的席位串行化） */
  async lockActiveOrgSubscription(
    c: RepoContext,
    input: { orgId: number; now: Date },
  ): Promise<{ id: number; quantity: number } | null> {
    const [row] = await tx(c)
      .select({ id: userSubscriptions.id, quantity: userSubscriptions.quantity })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.orgId, input.orgId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, input.now),
        ),
      )
      .for('update');
    return row ?? null;
  }

  async findActiveOrgSubscription(
    c: RepoContext,
    input: { orgId: number; now: Date },
  ): Promise<{ id: number; quantity: number } | null> {
    const [row] = await c.db
      .select({ id: userSubscriptions.id, quantity: userSubscriptions.quantity })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.orgId, input.orgId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, input.now),
        ),
      );
    return row ?? null;
  }

  async countActiveMembers(c: RepoContext, orgId: number): Promise<number> {
    const [row] = await c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 0)));
    return row?.n ?? 0;
  }

  async countPendingInvitations(
    c: RepoContext,
    input: { orgId: number; now: Date },
  ): Promise<number> {
    const [row] = await c.db
      .select({ n: sql<number>`count(*)::int` })
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, input.orgId),
          eq(orgInvitations.status, 0),
          gt(orgInvitations.expiresAt, input.now),
        ),
      );
    return row?.n ?? 0;
  }

  async insertInvitation(
    c: RepoContext,
    input: { orgId: number; email: string; token: string; invitedByUserId: number; expiresAt: Date },
  ): Promise<{ id: number; token: string }> {
    const [row] = await tx(c)
      .insert(orgInvitations)
      .values({
        orgId: input.orgId,
        email: input.email,
        token: input.token,
        invitedByUserId: input.invitedByUserId,
        status: 0,
        expiresAt: input.expiresAt,
      })
      .returning({ id: orgInvitations.id, token: orgInvitations.token });
    return row!;
  }

  async findInvitationByToken(
    c: RepoContext,
    token: string,
  ): Promise<InvitationRow | null> {
    const [row] = await c.db
      .select({
        id: orgInvitations.id,
        orgId: orgInvitations.orgId,
        email: orgInvitations.email,
        status: orgInvitations.status,
        expiresAt: orgInvitations.expiresAt,
      })
      .from(orgInvitations)
      .where(eq(orgInvitations.token, token));
    return row ?? null;
  }

  /** 撤销（CAS 0→2） */
  async revokeInvitation(
    c: RepoContext,
    input: { orgId: number; invitationId: number },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(orgInvitations)
      .set({ status: 2, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(orgInvitations.id, input.invitationId),
          eq(orgInvitations.orgId, input.orgId),
          eq(orgInvitations.status, 0),
        ),
      )
      .returning({ id: orgInvitations.id });
    return rows.length > 0;
  }

  /**
   * 加入成员（重入语义：被移除成员再接受 → 复活该行——静默跳过会让
   * 邀请标记 accepted 但成员没回来，owner 看到假状态）。
   */
  async insertOrReviveMember(
    c: RepoContext,
    input: { orgId: number; userId: number; role: string },
  ): Promise<void> {
    await tx(c)
      .insert(orgMembers)
      .values({ orgId: input.orgId, userId: input.userId, role: input.role, status: 0 })
      .onConflictDoUpdate({
        target: [orgMembers.orgId, orgMembers.userId],
        set: { status: 0, updatedAt: sql`clock_timestamp()` },
        setWhere: eq(orgMembers.status, 1),
      });
  }

  /**
   * 邀请原子翻转（pending+未过期 → accepted）：0 行 = 读检查与翻转之间
   * 被并发撤销/接受/过期——调用方必须回滚（成员插入一并撤销）。
   */
  async acceptInvitation(
    c: RepoContext,
    input: { invitationId: number; userId: number; now: Date },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(orgInvitations)
      .set({ status: 1, acceptedByUserId: input.userId, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(orgInvitations.id, input.invitationId),
          eq(orgInvitations.status, 0),
          gt(orgInvitations.expiresAt, input.now),
        ),
      )
      .returning({ id: orgInvitations.id });
    return rows.length > 0;
  }

  /** 我所属的组织（附 active 订阅由 service 二次查询拼装） */
  async listMembershipsForUser(
    c: RepoContext,
    userId: number,
  ): Promise<Array<{ orgId: number; name: string; role: string }>> {
    return c.db
      .select({ orgId: organizations.id, name: organizations.name, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(and(eq(orgMembers.userId, userId), eq(orgMembers.status, 0)))
      .orderBy(desc(organizations.id));
  }

  /** 成员列表（附用户展示信息） */
  async listMembers(
    c: RepoContext,
    orgId: number,
  ): Promise<
    Array<{
      userId: number;
      role: string;
      status: number;
      dailySpendLimit: string | null;
      monthlyQuota: string | null;
      email: string | null;
      displayName: string | null;
    }>
  > {
    return c.db
      .select({
        userId: orgMembers.userId,
        role: orgMembers.role,
        status: orgMembers.status,
        dailySpendLimit: orgMembers.dailySpendLimit,
        monthlyQuota: orgMembers.monthlyQuota,
        email: users.email,
        displayName: users.displayName,
      })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.orgId, orgId));
  }

  /** 待接受邀请（owner 视图；不含 token——token 只在创建时下发一次） */
  async listPendingInvitations(
    c: RepoContext,
    input: { orgId: number; now: Date },
  ): Promise<InvitationRow[]> {
    return c.db
      .select({
        id: orgInvitations.id,
        orgId: orgInvitations.orgId,
        email: orgInvitations.email,
        status: orgInvitations.status,
        expiresAt: orgInvitations.expiresAt,
      })
      .from(orgInvitations)
      .where(
        and(
          eq(orgInvitations.orgId, input.orgId),
          eq(orgInvitations.status, 0),
          gt(orgInvitations.expiresAt, input.now),
        ),
      )
      .orderBy(orgInvitations.id);
  }

  /** owner 设置成员日限/子配额 */
  async patchMember(
    c: RepoContext,
    input: {
      orgId: number;
      userId: number;
      patch: { dailySpendLimit?: string | null; monthlyQuota?: string | null };
    },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(orgMembers)
      .set({ ...input.patch, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.userId)))
      .returning({ id: orgMembers.id });
    return rows.length > 0;
  }

  /** 移除成员（CAS status=0→1；owner 不可移除——service 层判定） */
  async removeMember(
    c: RepoContext,
    input: { orgId: number; userId: number },
  ): Promise<boolean> {
    const rows = await tx(c)
      .update(orgMembers)
      .set({ status: 1, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(orgMembers.orgId, input.orgId),
          eq(orgMembers.userId, input.userId),
          eq(orgMembers.status, 0),
        ),
      )
      .returning({ id: orgMembers.id });
    return rows.length > 0;
  }

  /**
   * 凭证绑定守卫读模型：用户能否绑定该订阅（owner 本人，或订阅组织 active 成员）。
   * 创建面不得静默接受他人订阅（与授权侧防御互为纵深）。
   */
  async findUsableSubscription(
    c: RepoContext,
    input: { userId: number; subscriptionId: number; now: Date },
  ): Promise<{ userId: number; orgId: number | null } | null> {
    const [sub] = await c.db
      .select({ userId: userSubscriptions.userId, orgId: userSubscriptions.orgId })
      .from(userSubscriptions)
      .where(
        and(
          eq(userSubscriptions.id, input.subscriptionId),
          eq(userSubscriptions.status, 0),
          gt(userSubscriptions.endAt, input.now),
        ),
      );
    if (!sub) return null;
    if (sub.userId === input.userId) return sub;
    if (sub.orgId != null) {
      const member = await this.findActiveMembership(c, { orgId: sub.orgId, userId: input.userId });
      if (member) return sub;
    }
    return null;
  }
}
