/**
 * 接口绑定管理路由（ADR-0009:执行面数据化——本路由自身也被绑定表守护,
 * 种子 = 0084 的 admins 域四码）。审计:binding.created/updated/deleted。
 * PATCH 为部分更新（method/path/permissionId 至少一项）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ControlPlane } from '@tillgate/control-plane';
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
  /** 部分更新:三字段全可选,至少一项（终态唯一性由用例层守卫） */
  update: z
    .object({
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
      path: z.string().trim().min(2).max(255).optional(),
      permissionId: z.number().int().min(1).optional(),
    })
    .refine(
      (body) =>
        body.method !== undefined || body.path !== undefined || body.permissionId !== undefined,
      {
        message: 'at least one of method/path/permissionId is required',
      },
    ),
} as const;

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为 v1 平移语义(存量棘轮)
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
    const body = endpointContracts.update.parse(await c.req.json());
    const updated = await deps.rbac.endpoints.update(id, body);
    if (updated == null) {
      throw AdminErrors.business('admin_not_found', { bindingId: id });
    }
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'binding.updated',
      targetType: 'endpoint_binding',
      targetId: id,
      detail: {
        method: updated.method,
        path: updated.path,
        permissionId: updated.permissionId,
        changed: Object.keys(body),
      },
    });
    return c.json(updated);
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
