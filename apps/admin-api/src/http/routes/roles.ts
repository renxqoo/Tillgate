/**
 * 角色管理路由（动态 RBAC——docs/admin-rbac-dynamic/DESIGN §5;admins 域码守护）。
 * 审计:created/updated（detail 含 added/removed 授权 diff——安全取证主观察面）/deleted。
 */
import { Hono } from 'hono';
import type { ControlPlane } from '@tokenlens/control-plane';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { rbacContracts } from '../contracts/rbac';
import type { PostAudit } from './redeem';

/** 排序白名单（统一列表契约） */
const ROLE_SORTS = ['id', 'code', 'createdAt'] as const;

export interface RolesRoutesDeps {
  readonly rbac: ControlPlane['rbac'];
  postAudit: PostAudit;
}

export function rolesRoutes(deps: RolesRoutesDeps) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/roles', async (c) => {
    const query = parseListQuery(c.req.query(), ROLE_SORTS, 'id');
    const page = await deps.rbac.roles.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'code' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows, page.total, query));
  });

  app.post('/v1/roles', async (c) => {
    const body = rbacContracts.createRole.parse(await c.req.json());
    const role = await deps.rbac.roles.create({
      code: body.code,
      name: body.name,
      description: body.description ?? null,
      codes: body.permissions,
    });
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'role.created',
      targetType: 'role',
      targetId: role.id,
      detail: { code: role.code, permissions: body.permissions },
    });
    return c.json(role, 201);
  });

  app.patch('/v1/roles/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = rbacContracts.patchRole.parse(await c.req.json());
    const result = await deps.rbac.roles.update({
      roleId: id,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.permissions !== undefined ? { codes: body.permissions } : {}),
    });
    if (result == null) {
      throw AdminErrors.business('admin_not_found', { roleId: id });
    }
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'role.updated',
      targetType: 'role',
      targetId: id,
      detail: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.permissions !== undefined
          ? { permissions: body.permissions, added: result.added, removed: result.removed }
          : {}),
      },
    });
    return c.json(result.role);
  });

  app.delete('/v1/roles/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    await deps.rbac.roles.remove(id);
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'role.deleted',
      targetType: 'role',
      targetId: id,
      detail: null,
    });
    return c.json({ ok: true });
  });

  return app;
}
