import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { organizations, orgInvitations, orgMembers, plans, users, userSubscriptions } from '@ai-gateway/db/schema';
import { z } from 'zod';
import {
  MONEY_MAX,
  HttpError,
  intParam,
  jsonBody,
  paginateQuery,
  query,
  recordAudit,
  listQuerySchema,
  buildList,
} from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';

/**
 * 组织/成员（org/member 计费模型，plan-org-member-billing.md）。
 *
 *   - GET /orgs：我所属的组织列表
 *   - GET /orgs/:id：组织详情 + 成员列表
 *   - POST /orgs/:id/invitations：owner 邀请（按 email，校验席位余量）
 *   - POST /orgs/invitations/accept：接受邀请（须登录 + email 匹配）
 *   - PATCH /orgs/:id/members/:userId：owner 设置成员日限/子配额
 *   - DELETE /orgs/:id/members/:userId：owner 移除成员
 */

const inviteSchema = z.object({
  email: z.string().email().max(255),
});

const memberPatchSchema = z.object({
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
  monthlyQuota: z.number().min(0).max(MONEY_MAX).nullable().optional(),
});

/** 校验当前用户是某组织的 owner（返回成员行）。 */
async function requireOwner(s: ClientServices, orgId: number, userId: number) {
  const m = await s.db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), eq(orgMembers.status, 0)),
  });
  if (!m || m.role !== 'owner') {
    throw new HttpError('ORG_FORBIDDEN', '无权操作该组织（仅 owner 可操作）');
  }
  return m;
}

/** 读组织的 active 订阅（org_id 关联）；无则视为不可邀请。 */
async function activeOrgSubscription(s: ClientServices, orgId: number) {
  return s.db.query.userSubscriptions.findFirst({
    where: and(
      eq(userSubscriptions.orgId, orgId),
      eq(userSubscriptions.status, 0),
      gt(userSubscriptions.endAt, new Date()),
    ),
  });
}

export function orgRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()

    // 我所属的组织列表
    .get('/', query(listQuerySchema), async (c) => {
      const session = c.get('session');
      const input = c.req.valid('query');
      const { page, limit, offset, where, orderBy } = buildList(input, {
        search: [organizations.name],
        conditions: [eq(orgMembers.userId, session.userId), eq(orgMembers.status, 0)],
        sort: {
          by: { id: organizations.id, name: organizations.name, createdAt: organizations.createdAt },
          fallback: 'createdAt',
          tiebreaker: organizations.id,
        },
      });
      const result = await paginateQuery(
        page,
        s.db
          .select({
            id: organizations.id,
            name: organizations.name,
            role: orgMembers.role,
            orgId: orgMembers.orgId,
            userId: orgMembers.userId,
          })
          .from(orgMembers)
          .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .offset(offset),
        // 计数含 innerJoin：搜索目标是关联表 organizations.name
        s.db
          .select({ count: sql<number>`count(*)::int` })
          .from(orgMembers)
          .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(where),
      );
      const rows = result.list;

      // 附每个组织的 active 订阅（供 key 计费来源下拉 + 展示）
      const orgIds = rows.map((r) => r.orgId);
      const subs =
        orgIds.length === 0
          ? []
          : await s.db
              .select({
                id: userSubscriptions.id,
                orgId: userSubscriptions.orgId,
                planName: plans.name,
                quantity: userSubscriptions.quantity,
                quotaAmount: userSubscriptions.quotaAmount,
                usedAmount: userSubscriptions.usedAmount,
                reservedAmount: userSubscriptions.reservedAmount,
              })
              .from(userSubscriptions)
              .innerJoin(plans, eq(userSubscriptions.planId, plans.id))
              .where(
                and(
                  inArray(userSubscriptions.orgId, orgIds),
                  eq(userSubscriptions.status, 0),
                  gt(userSubscriptions.endAt, new Date()),
                ),
              );
      const list = rows.map((r) => {
        const sub = subs.find((x) => x.orgId === r.orgId);
        return {
          id: r.id,
          name: r.name,
          role: r.role,
          subscriptionId: sub?.id ?? null,
          subscriptionName: sub?.planName ?? null,
          quantity: sub?.quantity ?? null,
          quotaAmount: sub?.quotaAmount ?? null,
          usedAmount: sub?.usedAmount ?? null,
          reservedAmount: sub?.reservedAmount ?? null,
          remainingAmount:
            sub == null
              ? null
              : (Number(sub.quotaAmount) - Number(sub.usedAmount) - Number(sub.reservedAmount)).toString(),
        };
      });
      return c.json({ ...result, list });
    })

    // 组织详情 + 成员列表
    .get('/:id', async (c) => {
      const session = c.get('session');
      const orgId = intParam(c, 'id');
      const member = await s.db.query.orgMembers.findFirst({
        where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, session.userId), eq(orgMembers.status, 0)),
      });
      if (!member) throw new HttpError('ORG_NOT_FOUND', '组织不存在或你不在其中');
      const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
      const members = await s.db
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
      // 待接受邀请（仅 owner 可见）：前端提供撤销入口；不含 token（链接只在邀请时下发一次）
      const invitations =
        member.role === 'owner'
          ? await s.db
              .select({
                id: orgInvitations.id,
                email: orgInvitations.email,
                status: orgInvitations.status,
                expiresAt: orgInvitations.expiresAt,
                createdAt: orgInvitations.createdAt,
              })
              .from(orgInvitations)
              .where(
                and(
                  eq(orgInvitations.orgId, orgId),
                  eq(orgInvitations.status, 0),
                  gt(orgInvitations.expiresAt, new Date()),
                ),
              )
              .orderBy(orgInvitations.id)
          : [];
      return c.json({ org, members, invitations });
    })

    // owner 邀请（按 email，校验席位余量）
    .post('/:id/invitations', jsonBody(inviteSchema), async (c) => {
      const session = c.get('session');
      const orgId = intParam(c, 'id');
      const body = c.req.valid('json');
      await requireOwner(s, orgId, session.userId);

      const sub = await activeOrgSubscription(s, orgId);
      if (!sub) throw new HttpError('ORG_NO_SUBSCRIPTION', '组织尚无有效套餐，无法邀请');
      const activeCount = await s.db
        .select({ count: sql<number>`count(*)::int` })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.status, 0)));
      if (Number(activeCount[0]?.count ?? 0) >= Number(sub.quantity)) {
        throw new HttpError('SEATS_FULL', '席位已满，无法再邀请');
      }
      // 待接受邀请上限：min(剩余席位 × 2, 20)——防脚本化刷邀请行（邀请在 accept 时
      // 才校验席位，创建面若无上限可无限堆 pending 行）
      const remainingSeats = Number(sub.quantity) - Number(activeCount[0]?.count ?? 0);
      const pendingCap = Math.min(Math.max(remainingSeats, 1) * 2, 20);
      const pending = await s.db
        .select({ count: sql<number>`count(*)::int` })
        .from(orgInvitations)
        .where(
          and(
            eq(orgInvitations.orgId, orgId),
            eq(orgInvitations.status, 0),
            gt(orgInvitations.expiresAt, new Date()),
          ),
        );
      if (Number(pending[0]?.count ?? 0) >= pendingCap) {
        throw new HttpError('INVITATIONS_FULL', '待接受邀请过多，请先撤销或等待处理');
      }

      const token = randomUUID().replace(/-/g, '');
      const [inv] = await s.db
        .insert(orgInvitations)
        .values({
          orgId,
          email: body.email.toLowerCase(),
          token,
          invitedByUserId: session.userId,
          status: 0,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        })
        .returning({ id: orgInvitations.id, token: orgInvitations.token });
      await recordAudit(s.db, {
        actor: 'user',
        action: 'org.invite',
        targetType: 'org_invitation',
        targetId: inv!.id,
        detail: { orgId, email: body.email },
      });
      return c.json({ invitation: inv }, 201);
    })

    // owner 撤销待接受邀请（status 0 → 2 revoked；schema 语义补全）
    .post('/:id/invitations/:invitationId/revoke', async (c) => {
      const session = c.get('session');
      const orgId = intParam(c, 'id');
      const invitationId = intParam(c, 'invitationId');
      await requireOwner(s, orgId, session.userId);
      const revoked = await s.db
        .update(orgInvitations)
        .set({ status: 2, updatedAt: new Date() })
        .where(
          and(
            eq(orgInvitations.id, invitationId),
            eq(orgInvitations.orgId, orgId),
            eq(orgInvitations.status, 0),
          ),
        )
        .returning({ id: orgInvitations.id });
      if (revoked.length === 0) {
        throw new HttpError('INVITATION_NOT_FOUND', '邀请不存在或已处理');
      }
      await recordAudit(s.db, {
        actor: 'user',
        action: 'org.invitation_revoke',
        targetType: 'org_invitation',
        targetId: invitationId,
      });
      return c.json({ ok: true });
    })

    // 接受邀请（须登录 + email 匹配）
    .post('/invitations/accept', jsonBody(z.object({ token: z.string().min(1).max(64) })), async (c) => {
      const session = c.get('session');
      const { token } = c.req.valid('json');
      const user = await s.db.query.users.findFirst({
        where: eq(users.id, session.userId),
        columns: { id: true, email: true, subject: true },
      });
      if (!user) throw new HttpError('USER_NOT_FOUND', '用户不存在');

      const inv = await s.db.query.orgInvitations.findFirst({
        where: eq(orgInvitations.token, token),
      });
      // 快路径分型提示（防 TOCTOU 的权威校验在事务内的原子翻转，见下）
      if (!inv) throw new HttpError('INVITATION_INVALID', '邀请链接无效或已过期');
      if (inv.status === 2) throw new HttpError('INVITATION_REVOKED', '邀请已被撤销');
      if (inv.status === 1) throw new HttpError('INVITATION_ALREADY_ACCEPTED', '邀请已被接受');
      if (inv.expiresAt <= new Date()) throw new HttpError('INVITATION_EXPIRED', '邀请已过期');
      // 登录账号须与邀请 email 一致（无 email 时按 subject 兜底）
      const userEmail = user.email?.toLowerCase();
      if (userEmail !== inv.email.toLowerCase() && user.subject !== inv.email) {
        throw new HttpError('INVITATION_EMAIL_MISMATCH', '登录账号与邀请邮箱不一致');
      }

      // 事务：锁订阅行（串行化席位校验）+ 复检席位 + 加入成员 + 标记 accepted
      await s.db.transaction(async (tx) => {
        const subs = await tx
          .select({ id: userSubscriptions.id, quantity: userSubscriptions.quantity })
          .from(userSubscriptions)
          .where(
            and(
              eq(userSubscriptions.orgId, inv.orgId),
              eq(userSubscriptions.status, 0),
              gt(userSubscriptions.endAt, new Date()),
            ),
          )
          .for('update');
        const sub = subs[0];
        if (!sub) throw new HttpError('ORG_NO_SUBSCRIPTION', '组织套餐已失效');
        const activeCount = await tx.execute<{ count: string }>(sql`
          select count(*)::text as count from org_members
          where org_id = ${inv.orgId} and status = 0
        `);
        if (Number(activeCount.rows[0]?.count ?? '0') >= Number(sub.quantity)) {
          throw new HttpError('SEATS_FULL', '席位已满');
        }
        await tx
          .insert(orgMembers)
          .values({ orgId: inv.orgId, userId: session.userId, role: 'member', status: 0 })
          // 重入语义：成员被移除（status=1）后再次接受邀请 → 复活该行；
          // 原先 onConflictDoNothing 会静默跳过但邀请仍标记 accepted（owner 以为成员回来了）
          .onConflictDoUpdate({
            target: [orgMembers.orgId, orgMembers.userId],
            set: { status: 0, updatedAt: new Date() },
            setWhere: eq(orgMembers.status, 1),
          });
        // 原子翻转：pending + 未过期 → accepted。0 行命中说明读检查与翻转之间
        // 邀请被并发撤销/接受/过期——必须报错回滚（成员插入一并撤销），
        // 不得静默吞掉（否则出现「成员已加入但邀请 revoked」的半成品状态）
        const flipped = await tx
          .update(orgInvitations)
          .set({ status: 1, acceptedByUserId: session.userId, updatedAt: new Date() })
          .where(
            and(
              eq(orgInvitations.id, inv.id),
              eq(orgInvitations.status, 0),
              gt(orgInvitations.expiresAt, new Date()),
            ),
          )
          .returning({ id: orgInvitations.id });
        if (flipped.length === 0) {
          const fresh = await tx.query.orgInvitations.findFirst({
            where: eq(orgInvitations.id, inv.id),
            columns: { status: true },
          });
          if (fresh?.status === 2) throw new HttpError('INVITATION_REVOKED', '邀请已被撤销');
          if (fresh?.status === 1) throw new HttpError('INVITATION_ALREADY_ACCEPTED', '邀请已被接受');
          throw new HttpError('INVITATION_EXPIRED', '邀请已过期');
        }
      });

      await recordAudit(s.db, {
        actor: 'user',
        action: 'org.invitation_accept',
        targetType: 'org_invitation',
        targetId: inv.id,
        detail: { orgId: inv.orgId },
      });
      return c.json({ ok: true, orgId: inv.orgId });
    })

    // owner 设置成员日限/子配额
    .patch('/:id/members/:userId', jsonBody(memberPatchSchema), async (c) => {
      const session = c.get('session');
      const orgId = intParam(c, 'id');
      const memberUserId = intParam(c, 'userId');
      const body = c.req.valid('json');
      await requireOwner(s, orgId, session.userId);

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (body.dailySpendLimit !== undefined)
        update.dailySpendLimit = body.dailySpendLimit == null ? null : String(body.dailySpendLimit);
      if (body.monthlyQuota !== undefined)
        update.monthlyQuota = body.monthlyQuota == null ? null : String(body.monthlyQuota);
      const [updated] = await s.db
        .update(orgMembers)
        .set(update)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, memberUserId)))
        .returning({ orgId: orgMembers.orgId, userId: orgMembers.userId });
      if (!updated) throw new HttpError('ORG_MEMBER_NOT_FOUND', '成员不存在');
      return c.json(updated);
    })

    // owner 移除成员（离开组织，历史 usage 保留归属）
    .delete('/:id/members/:userId', async (c) => {
      const session = c.get('session');
      const orgId = intParam(c, 'id');
      const memberUserId = intParam(c, 'userId');
      await requireOwner(s, orgId, session.userId);
      if (memberUserId === session.userId) {
        throw new HttpError('ORG_CANNOT_REMOVE_OWNER', 'owner 不能被移除');
      }
      const [removed] = await s.db
        .update(orgMembers)
        .set({ status: 1, updatedAt: new Date() })
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, memberUserId), eq(orgMembers.status, 0)))
        .returning({ orgId: orgMembers.orgId, userId: orgMembers.userId });
      if (!removed) throw new HttpError('ORG_MEMBER_NOT_FOUND', '成员不存在');
      await recordAudit(s.db, {
        actor: 'user',
        action: 'org.remove_member',
        targetType: 'org_member',
        targetId: `${orgId}:${memberUserId}`,
      });
      return c.json({ ok: true });
    });
}
