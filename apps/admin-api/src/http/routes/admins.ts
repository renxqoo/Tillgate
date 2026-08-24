/**
 * 管理员管理路由（RBAC admins 域——super_admin 专属;docs/admin-rbac/DESIGN §2.5）。
 *
 * 创建 = 双动词编排（两包无共享事务边界,失败补偿）：
 *   1. control-plane 建资料行（admin id ≥1e9 段分配 + role 落库）
 *   2. identity 注册 email 凭据 + 初始密码（策略单源校验在此）
 *   3. 凭据被占（identifier_taken——邮箱被任何身份占用）→ 补偿删资料行 → 409 同码
 *      （绝不留「创建成功但永远登不上」的废号——create-admin 脚本同裁决）
 *   4. 双动词全部成功才旁路审计（postAudit——两步全成才算「创建」）
 *
 * 更新 = role/status/displayName 部分更新;「不可改自身 role/status」守卫在此
 * （会话身份是路由的知识——防最后一个超管自锁,DESIGN D6）。
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { isBusinessError } from '@tokenlens/errors';
import { controlPlaneErrors, type AdminRecord, type ControlPlane } from '@tokenlens/control-plane';
import type { Identity } from '@tokenlens/identity';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { idParam, listEnvelope, parseListQuery } from '../contracts/common';
import { adminsContracts } from '../contracts/admins';
import type { PostAudit } from './redeem';

/** 排序白名单（sort_by 词表外 400 admin.invalid_sort_field——统一列表契约） */
const ADMIN_SORTS = ['id', 'email', 'lastLoginAt', 'createdAt'] as const;

export interface AdminsRoutesDeps {
  /** admins 资料面动词（list/create/update/remove） */
  admins: Pick<ControlPlane['admins'], 'list' | 'create' | 'update' | 'remove'>;
  /** 凭据注册（email 标识 + 初始密码;策略单源校验在 identity 内） */
  identity: Pick<Identity, 'credentials'>;
  postAudit: PostAudit;
}

/** wire 形状（列表/创建/更新共用的资料投影——不含密码/2FA 密钥列） */
function adminRowOf(record: AdminRecord) {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    status: record.status,
    twoFactorEnabled: record.twoFactorEnabled,
    lastLoginAt: record.lastLoginAt,
    createdAt: record.createdAt,
  };
}

export function adminsRoutes(deps: AdminsRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/admins', session, async (c) => {
    const query = parseListQuery(c.req.query(), ADMIN_SORTS, 'id');
    const page = await deps.admins.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      sortBy: query.sortBy as 'id' | 'email' | 'lastLoginAt' | 'createdAt',
      order: query.order,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(listEnvelope(page.rows.map(adminRowOf), page.total, query));
  });

  app.post('/v1/admins', session, async (c) => {
    const body = adminsContracts.create.parse(await c.req.json());
    const created = await deps.admins.create({
      email: body.email,
      displayName: body.displayName ?? null,
      role: body.role,
    });
    try {
      await deps.identity.credentials.register({
        userId: created.id,
        identifier: { kind: 'email', value: created.email },
        password: body.password,
      });
    } catch (error) {
      // 补偿收回资料行——凭据没注册成功的管理员是废号,不留孤儿
      await deps.admins.remove(created.id).catch(() => undefined);
      if (isBusinessError(error) && error.code === 'identity.identifier_taken') {
        throw controlPlaneErrors.business('admin_email_taken', {
          email: created.email,
          source: 'identity',
        });
      }
      throw error;
    }
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'admin.created',
      targetType: 'admin',
      targetId: created.id,
      detail: { email: created.email, role: created.role },
    });
    return c.json(adminRowOf(created), 201);
  });

  app.patch('/v1/admins/:id', session, async (c) => {
    const id = idParam(c.req.param('id'));
    const body = adminsContracts.patch.parse(await c.req.json());
    // 自改守卫：role/status 不可改自身（displayName 可改——无权限面影响,DESIGN D6）
    if (id === c.get('adminId') && (body.role !== undefined || body.status !== undefined)) {
      throw AdminErrors.business('cannot_modify_self', {});
    }
    const updated = await deps.admins.update({
      adminId: id,
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    if (updated == null) {
      throw AdminErrors.business('admin_not_found', { adminId: id });
    }
    await deps.postAudit({
      actor: 'admin',
      adminId: c.get('adminId'),
      action: 'admin.updated',
      targetType: 'admin',
      targetId: id,
      detail: {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });
    return c.json(adminRowOf(updated));
  });

  return app;
}
