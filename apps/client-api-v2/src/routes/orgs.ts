/**
 * 组织路由（会话）：我的组织 / 详情 / 邀请 / 撤销 / 接受 / 成员限额 / 移除。
 * 邀请 token 只在创建响应下发一次（列表永不回 token）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { userCtxOf } from './ctx.js';
import type { SessionEnv } from '../middleware/session.js';
import type { OrgService } from '../services/org.service.js';
import { isValidDailySpendLimitInput } from '../domain/key-limits.js';

const orgIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email().max(255) });

const invitationParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  invitationId: z.coerce.number().int().positive(),
});

const acceptSchema = z.object({ token: z.string().trim().min(1).max(64) });

// 结构性金额校验（与 keys 路由同口径——负值/科学计数法/超尺度进 numeric 列即 500 或口径污染）
const memberPatchSchema = z.object({
  dailySpendLimit: z
    .string()
    .refine(isValidDailySpendLimitInput, '必须为正金额（过大或格式非法）')
    .nullable()
    .optional(),
  monthlyQuota: z
    .string()
    .refine(isValidDailySpendLimitInput, '必须为正金额（过大或格式非法）')
    .nullable()
    .optional(),
});

export function orgRoutes(service: OrgService, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/orgs', session, async (c) => {
    const rows = await service.listMyOrgs(userCtxOf(c), c.get('userId'));
    return c.json({ rows });
  });

  app.get('/v1/orgs/:id', session, async (c) => {
    const { id } = orgIdParamSchema.parse(c.req.param());
    const result = await service.orgDetail(userCtxOf(c), c.get('userId'), id);
    return c.json(result);
  });

  app.post('/v1/orgs/:id/invitations', session, async (c) => {
    const { id } = orgIdParamSchema.parse(c.req.param());
    const body = inviteSchema.parse(await c.req.json());
    const result = await service.invite(userCtxOf(c), c.get('userId'), id, body.email);
    return c.json(result, 201);
  });

  app.post('/v1/orgs/:id/invitations/:invitationId/revoke', session, async (c) => {
    const { id, invitationId } = invitationParamSchema.parse(c.req.param());
    await service.revokeInvitation(userCtxOf(c), c.get('userId'), id, invitationId);
    return c.json({ ok: true });
  });

  app.post('/v1/orgs/invitations/accept', session, async (c) => {
    const body = acceptSchema.parse(await c.req.json());
    const result = await service.acceptInvitation(userCtxOf(c), c.get('userId'), body.token);
    return c.json(result);
  });

  app.patch('/v1/orgs/:id/members/:memberUserId', session, async (c) => {
    const { id } = orgIdParamSchema.parse(c.req.param());
    const memberUserId = z.coerce.number().int().positive().parse(c.req.param('memberUserId'));
    const body = memberPatchSchema.parse(await c.req.json());
    await service.patchMember(userCtxOf(c), c.get('userId'), id, memberUserId, body);
    return c.json({ ok: true });
  });

  app.delete('/v1/orgs/:id/members/:memberUserId', session, async (c) => {
    const { id } = orgIdParamSchema.parse(c.req.param());
    const memberUserId = z.coerce.number().int().positive().parse(c.req.param('memberUserId'));
    await service.removeMember(userCtxOf(c), c.get('userId'), id, memberUserId);
    return c.json({ ok: true });
  });

  return app;
}
