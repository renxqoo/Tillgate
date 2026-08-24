/**
 * 权限资源路由（动态 RBAC 权限树管理面——docs/admin-rbac-dynamic/DESIGN §5;admins 域码）。
 * GET tree = 平铺节点（前端自组树）;custom 节点 CRUD,enforced 节点仅展示字段可改。
 */
import { Hono } from 'hono';
import type { ControlPlane, PermissionNode } from '@tillgate/control-plane';
import type { SessionEnv } from '../middleware/session';
import { idParam } from '../contracts/common';
import { rbacContracts } from '../contracts/rbac';
import type { PostAudit } from './redeem';

export interface PermissionsRoutesDeps {
  readonly rbac: ControlPlane['rbac'];
  postAudit: PostAudit;
}

function nodeWire(node: PermissionNode) {
  return {
    id: node.id,
    parentId: node.parentId,
    type: node.type,
    code: node.code,
    name: node.name,
    i18nKey: node.i18nKey,
    description: node.description,
    path: node.path,
    icon: node.icon,
    sortOrder: node.sortOrder,
    status: node.status,
    source: node.source,
    createdAt: node.createdAt,
  };
}

// eslint-disable-next-line max-lines-per-function -- 路由表装配平铺:注册即数据,内联处理器为 v1 平移语义(存量棘轮)
export function permissionsRoutes(deps: PermissionsRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/permissions/tree', async (c) => {
    const nodes = await deps.rbac.permissions.tree();
    return c.json({ rows: nodes.map(nodeWire) });
  });

  app.post('/v1/permissions', async (c) => {
    const body = rbacContracts.createPermission.parse(await c.req.json());
    const node = await deps.rbac.permissions.create({
      parentId: body.parentId,
      type: body.type,
      code: body.code ?? null,
      name: body.name,
      i18nKey: body.i18nKey ?? null,
      description: body.description ?? null,
      path: body.path ?? null,
      icon: body.icon ?? null,
      sortOrder: body.sortOrder,
    });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'permission.created',
      targetType: 'permission',
      targetId: node.id,
      detail: { type: node.type, code: node.code, name: node.name },
    });
    return c.json(nodeWire(node), 201);
  });

  app.patch('/v1/permissions/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = rbacContracts.patchPermission.parse(await c.req.json());
    const node = await deps.rbac.permissions.update({
      id,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.i18nKey !== undefined ? { i18nKey: body.i18nKey } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.path !== undefined ? { path: body.path } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.code !== undefined ? { code: body.code } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
    });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'permission.updated',
      targetType: 'permission',
      targetId: id,
      detail: { ...body },
    });
    return c.json(nodeWire(node));
  });

  app.delete('/v1/permissions/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    await deps.rbac.permissions.remove(id);
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'permission.deleted',
      targetType: 'permission',
      targetId: id,
      detail: null,
    });
    return c.json({ ok: true });
  });

  return app;
}
