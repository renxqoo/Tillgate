import { Hono } from 'hono';
import { z } from 'zod';
import { MONEY_MAX, intParam, jsonBody, listQuerySchema, query } from '@ai-gateway/http';
import type { ClientEnv } from '@ai-gateway/identity';
import type { ClientServices } from '../services/index.js';
import {
  acceptInvitation,
  getOrgDetail,
  inviteMember,
  listMyOrgs,
  patchMember,
  removeMember,
  revokeInvitation,
} from '../services/orgs.js';

/**
 * 组织/成员（org/member 计费模型，plan-org-member-billing.md）。
 * 席位/邀请不变量与审计在 services/orgs.ts；路由只做入参校验与响应塑形。
 */
const inviteSchema = z.object({
  email: z.string().email().max(255),
});

const memberPatchSchema = z.object({
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
  monthlyQuota: z.number().min(0).max(MONEY_MAX).nullable().optional(),
});

export function orgRoutes(s: ClientServices): Hono<ClientEnv> {
  return new Hono<ClientEnv>()
    .get('/', query(listQuerySchema), async (c) =>
      c.json(await listMyOrgs(s, c.get('session').userId, c.req.valid('query'))),
    )
    .get('/:id', async (c) => c.json(await getOrgDetail(s, c.get('session').userId, intParam(c, 'id'))))
    .post('/:id/invitations', jsonBody(inviteSchema), async (c) => {
      const inv = await inviteMember(s, c.get('session').userId, intParam(c, 'id'), c.req.valid('json').email);
      return c.json({ invitation: inv }, 201);
    })
    .post('/:id/invitations/:invitationId/revoke', async (c) => {
      await revokeInvitation(s, c.get('session').userId, intParam(c, 'id'), intParam(c, 'invitationId'));
      return c.json({ ok: true });
    })
    .post('/invitations/accept', jsonBody(z.object({ token: z.string().min(1).max(64) })), async (c) => {
      const orgId = await acceptInvitation(s, c.get('session').userId, c.req.valid('json').token);
      return c.json({ ok: true, orgId });
    })
    .patch('/:id/members/:userId', jsonBody(memberPatchSchema), async (c) =>
      c.json(await patchMember(s, c.get('session').userId, intParam(c, 'id'), intParam(c, 'userId'), c.req.valid('json'))),
    )
    .delete('/:id/members/:userId', async (c) => {
      await removeMember(s, c.get('session').userId, intParam(c, 'id'), intParam(c, 'userId'));
      return c.json({ ok: true });
    });
}
