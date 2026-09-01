/**
 * 组织路由（会话）：我的组织（订阅富化）/ 详情 / 邀请（token 只回一次）/ 撤销 /
 * 接受 / 成员限额 / 移除。
 */
import * as z from 'zod';
import { jsonBody,
  jsonBodyOf,
  type Middleware, routes } from '@tillgate/http';
import type { AccountUseCases } from '@tillgate/accounts';
import {
  acceptInvitationSchema,
  inviteSchema,
  invitationParamSchema,
  memberPatchSchema,
  orgIdParamSchema,
} from '../contracts/orgs.js';
import { toOrgRows, type OrgSubscriptionInfo } from '../presenters/orgs.js';
import { parsePath } from '../contracts/shared.js';
import type { SessionContext } from '../middleware/session.js';

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

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器平铺
export function orgRoutes(deps: OrgsDeps, session: Middleware<SessionContext>) {
  const app = routes<SessionContext>();
  const userIdParam = z.coerce.number().int().positive();

  app.get('/v1/orgs', session, async (c) => {
    const memberships = await deps.listMyOrgs(c.state.userId);
    const subs = await deps.orgSubscriptions(memberships.map((m) => m.orgId));
    const rows = toOrgRows(memberships, subs);
    return c.json({ rows, total: rows.length });
  });

  app.get('/v1/orgs/:id', session, async (c) => {
    const { id } = parsePath(orgIdParamSchema, c.params ?? {});
    const detail = await deps.orgDetail({ userId: c.state.userId, orgId: id });
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
    const { id } = parsePath(orgIdParamSchema, c.params ?? {});
    const body = jsonBodyOf(c, inviteSchema);
    const result = await deps.invite({
      orgId: id,
      operatorUserId: c.state.userId,
      email: body.email,
    });
    return c.json({ invitationId: result.invitationId, token: result.token }, 201);
  });

  app.post('/v1/orgs/:id/invitations/:invitationId/revoke', session, async (c) => {
    const { id, invitationId } = parsePath(invitationParamSchema, c.params ?? {});
    await deps.revokeInvitation({ orgId: id, operatorUserId: c.state.userId, invitationId });
    return c.json({ ok: true });
  });

  app.post('/v1/orgs/invitations/accept', session, jsonBody(acceptInvitationSchema), async (c) => {
    const body = jsonBodyOf(c, acceptInvitationSchema);
    const result = await deps.acceptInvitation({
      token: body.token,
      acceptorUserId: c.state.userId,
    });
    return c.json({ orgId: result.orgId });
  });

  app.patch(
    '/v1/orgs/:id/members/:memberUserId',
    session,
    jsonBody(memberPatchSchema),
    async (c) => {
      const { id } = parsePath(orgIdParamSchema, c.params ?? {});
      const memberUserId = userIdParam.parse((c.params?.['memberUserId'] ?? ''));
      const body = jsonBodyOf(c, memberPatchSchema);
      await deps.patchMember({
        orgId: id,
        operatorUserId: c.state.userId,
        memberUserId,
        dailySpendLimit: body.dailySpendLimit,
        monthlyQuota: body.monthlyQuota,
      });
      return c.json({ ok: true });
    },
  );

  app.delete('/v1/orgs/:id/members/:memberUserId', session, async (c) => {
    const { id } = parsePath(orgIdParamSchema, c.params ?? {});
    const memberUserId = userIdParam.parse((c.params?.['memberUserId'] ?? ''));
    await deps.removeMember({ orgId: id, operatorUserId: c.state.userId, memberUserId });
    return c.json({ ok: true });
  });

  return app.router;
}
