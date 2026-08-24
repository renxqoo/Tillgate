/**
 * 接口绑定管理路由（ADR-0009:执行面数据化——本路由自身也被绑定表守护,
 * 种子 = 0084 的 admins 域四码）。审计:binding.created/rebound/deleted。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ControlPlane } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { idParam } from '../contracts/common';
import type { PostAudit } from './redeem';

export interface EndpointsRoutesDeps {
  readonly rbac: ControlPlane['rbac'];
  postAudit: PostAudit;
}

const endpointContracts = {
  create: z.object({
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().trim().min(2).max(255),
    permissionId: z.number().int().min(1),
  }),
  rebind: z.object({ permissionId: z.number().int().min(1) }),
} as const;

export function endpointsRoutes(deps: EndpointsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/endpoint-bindings', async (c) => {
    const rows = await deps.rbac.endpoints.list();
    return c.json({ rows });
  });

  app.post('/v1/endpoint-bindings', async (c) => {
    const body = endpointContracts.create.parse(await c.req.json());
    const created = await deps.rbac.endpoints.create(body);
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'binding.created',
      targetType: 'endpoint_binding',
      targetId: created.id,
      detail: { method: created.method, path: created.path, permissionId: created.permissionId },
    });
    return c.json(created, 201);
  });

  app.patch('/v1/endpoint-bindings/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = endpointContracts.rebind.parse(await c.req.json());
    const rebound = await deps.rbac.endpoints.rebind(id, body.permissionId);
    if (rebound == null) {
      throw AdminErrors.business('admin_not_found', { bindingId: id });
    }
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'binding.rebound',
      targetType: 'endpoint_binding',
      targetId: id,
      detail: { method: rebound.method, path: rebound.path, permissionId: body.permissionId },
    });
    return c.json(rebound);
  });

  app.delete('/v1/endpoint-bindings/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    await deps.rbac.endpoints.remove(id);
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'binding.deleted',
      targetType: 'endpoint_binding',
      targetId: id,
      detail: null,
    });
    return c.json({ ok: true });
  });

  return app;
}
