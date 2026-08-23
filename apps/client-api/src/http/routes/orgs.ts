/**
 * 组织路由（会话）：我的组织（订阅富化）/ 详情 / 邀请（token 只回一次）/ 撤销 /
 * 接受 / 成员限额 / 移除。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { jsonBody } from '@tokenlens/http';
import type { AccountUseCases } from '@tokenlens/accounts';
import {
  acceptInvitationSchema,
  inviteSchema,
  invitationParamSchema,
  memberPatchSchema,
  orgIdParamSchema,
} from '../contracts/orgs.js';
import { toOrgRows, type OrgSubscriptionInfo } from '../presenters/orgs.js';
import { parsePath } from '../contracts/shared.js';
import type { SessionEnv } from '../middleware/session.js';

export interface OrgsDeps {
  readonly listMyOrgs: AccountUseCases['listMyOrgs'];
  readonly orgDetail: AccountUseCases['getOrgDetail'];
  readonly invite: AccountUseCases['inviteMember'];
  readonly revokeInvitation: AccountUseCases['revokeInvitation'];
  readonly acceptInvitation: AccountUseCases['acceptInvitation'];
  readonly patchMember: AccountUseCases['setMemberLimits'];
  readonly removeMember: AccountUseCases['removeMember'];
  /** 组织活跃订阅富化（subscription-read 适配器；orgIds 空表返回空 Map） */
  readonly orgSubscriptions: (
    orgIds: readonly number[],
  ) => Promise<ReadonlyMap<number, OrgSubscriptionInfo>>;
}

export function orgRoutes(deps: OrgsDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();
  const userIdParam = z.coerce.number().int().positive();

  app.get('/v1/orgs', session, async (c) => {
    const memberships = await deps.listMyOrgs(c.get('userId'));
    const subs = await deps.orgSubscriptions(memberships.map((m) => m.orgId));
    const rows = toOrgRows(memberships, subs);
    return c.json({ rows, total: rows.length });
  });

  app.get('/v1/orgs/:id', session, async (c) => {
    const { id } = parsePath(orgIdParamSchema, c.req.param());
    const detail = await deps.orgDetail({ userId: c.get('userId'), orgId: id });
    return c.json({
      org: { id: detail.org.id, name: detail.org.name },
      members: detail.members.map((m) => ({
        userId: m.userId,
        role: m.role,
        status: m.status,
        dailySpendLimit: m.dailySpendLimit,
        monthlyQuota: m.monthlyQuota,
        email: m.email,
        displayName: m.displayName,
      })),
      invitations: detail.invitations.map((i) => ({
        id: i.id,
        email: i.email,
        status: i.status,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
    });
  });

  app.post('/v1/orgs/:id/invitations', session, jsonBody(inviteSchema), async (c) => {
    const { id } = parsePath(orgIdParamSchema, c.req.param());
    const body = c.req.valid('json');
    const result = await deps.invite({
      orgId: id,
      operatorUserId: c.get('userId'),
      email: body.email,
    });
    return c.json({ invitationId: result.invitationId, token: result.token }, 201);
  });

  app.post('/v1/orgs/:id/invitations/:invitationId/revoke', session, async (c) => {
    const { id, invitationId } = parsePath(invitationParamSchema, c.req.param());
    await deps.revokeInvitation({ orgId: id, operatorUserId: c.get('userId'), invitationId });
    return c.json({ ok: true });
  });

  app.post('/v1/orgs/invitations/accept', session, jsonBody(acceptInvitationSchema), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.acceptInvitation({
      token: body.token,
      acceptorUserId: c.get('userId'),
    });
    return c.json({ orgId: result.orgId });
  });

  app.patch(
    '/v1/orgs/:id/members/:memberUserId',
    session,
    jsonBody(memberPatchSchema),
    async (c) => {
      const { id } = parsePath(orgIdParamSchema, c.req.param());
      const memberUserId = userIdParam.parse(c.req.param('memberUserId'));
      const body = c.req.valid('json');
      await deps.patchMember({
        orgId: id,
        operatorUserId: c.get('userId'),
        memberUserId,
        dailySpendLimit: body.dailySpendLimit,
        monthlyQuota: body.monthlyQuota,
      });
      return c.json({ ok: true });
    },
  );

  app.delete('/v1/orgs/:id/members/:memberUserId', session, async (c) => {
    const { id } = parsePath(orgIdParamSchema, c.req.param());
    const memberUserId = userIdParam.parse(c.req.param('memberUserId'));
    await deps.removeMember({ orgId: id, operatorUserId: c.get('userId'), memberUserId });
    return c.json({ ok: true });
  });

  return app;
}
