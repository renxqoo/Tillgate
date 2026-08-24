/**
 * 管理员自身路由（P2;v1 routes/me.ts 平移,会话组）：资料/改密/2FA 开关/TOTP。
 * v2（ADR-0008）：/v1/me 增 role 对象与 DB 授权码集合;新增 /v1/me/menus——
 * 按本人授权过滤的 group+page 两级树（sidebar 数据源,前端完全后端驱动）。
 */
import { Hono } from 'hono';
import { jsonBody } from '@tokenlens/http';
import type { MiddlewareHandler } from 'hono';
import type { ControlPlane, PermissionNode } from '@tokenlens/control-plane';
import { ENFORCED_CODES, granted } from '@tokenlens/control-plane';
import type { Identity } from '@tokenlens/identity';
import { AdminErrors } from '../error-face';
import type { SessionEnv } from '../middleware/session';
import { authContracts } from '../contracts/auth';

export interface MeRoutesDeps {
  readonly identity: Pick<Identity, 'passwords' | 'sessions' | 'mfa'>;
  readonly admins: Pick<ControlPlane['admins'], 'find' | 'setTwoFactorEnabled'>;
  /** 动态 RBAC：角色资料（me 的 role 对象）+ 权限树（menus 过滤） */
  readonly rbac: Pick<ControlPlane['rbac'], 'permissions'> & {
    roles: Pick<ControlPlane['rbac']['roles'], 'find'>;
  };
  readonly mailerConfigured: boolean;
  readonly sessionTtlSec: number;
}

/** sidebar 菜单树（group+page 两级;按授权过滤——page 无码 = 全员可见） */
function menuTreeOf(
  nodes: readonly PermissionNode[],
  grants: { isSuper: boolean; codes: readonly string[] },
) {
  const groups = nodes
    .filter((n) => n.type === 'group' && n.status === 0)
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
  const pages = nodes.filter((n) => n.type === 'page' && n.status === 0);
  return groups
    .map((group) => ({
      id: group.id,
      i18nKey: group.i18nKey,
      name: group.name,
      items: pages
        .filter((page) => page.parentId === group.id)
        .filter((page) => page.code == null || granted(grants, page.code))
        .toSorted((a, b) => a.sortOrder - b.sortOrder)
        .map((page) => ({
          id: page.id,
          i18nKey: page.i18nKey,
          name: page.name,
          path: page.path,
          icon: page.icon,
          code: page.code,
        })),
    }))
    .filter((group) => group.items.length > 0);
}

export function meRoutes(deps: MeRoutesDeps, session: MiddlewareHandler<SessionEnv>) {
  const app = new Hono<SessionEnv>();

  app.get('/v1/me', session, async (c) => {
    const adminId = c.get('adminId');
    const me = await deps.admins.find(adminId);
    if (me == null) {
      // 会话有效但资料行缺失（迁移不完整）——与 v1 同口径 401,不泄漏状态
      throw AdminErrors.business('admin_not_found', {});
    }
    const role = await deps.rbac.roles.find(me.roleId);
    const totp = await deps.identity.mfa.status({ userId: adminId });
    const grants = c.get('grants');
    return c.json({
      id: me.id,
      email: me.email,
      displayName: me.displayName,
      twoFactorEnabled: me.twoFactorEnabled,
      totpEnabled: totp.confirmed,
      lastLoginAt: me.lastLoginAt,
      // 动态 RBAC:角色对象 + 授权码集合（导航/按钮显隐的单一事实来源）
      role: {
        id: me.roleId,
        code: me.role,
        name: role?.name ?? me.role,
        isSuper: role?.isSuper ?? false,
      },
      permissions: grants?.isSuper ? [...ENFORCED_CODES] : [...(grants?.codes ?? [])],
    });
  });

  // sidebar 数据源（自身域无码——所有有效会话可调;树按本人授权过滤后下发）
  app.get('/v1/me/menus', session, async (c) => {
    const grants = c.get('grants') ?? { isSuper: false, codes: [] };
    const nodes = await deps.rbac.permissions.tree();
    return c.json({ groups: menuTreeOf(nodes, grants) });
  });

  app.post('/v1/me/password', session, async (c) => {
    const body = authContracts.changePassword.parse(await c.req.json());
    await deps.identity.passwords.change({
      userId: c.get('adminId'),
      realm: 'admin',
      currentPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    return c.json({
      token: await deps.identity.sessions.sign({
        realm: 'admin',
        subjectId: c.get('adminId'),
        ttlSec: deps.sessionTtlSec,
      }),
    });
  });

  app.post('/v1/me/two-factor', session, async (c) => {
    const body = authContracts.twoFactor.parse(await c.req.json());
    if (body.enabled && !deps.mailerConfigured) {
      throw AdminErrors.business('smtp_not_configured', {});
    }
    await deps.admins.setTwoFactorEnabled({ adminId: c.get('adminId'), enabled: body.enabled });
    return c.json({ twoFactorEnabled: body.enabled });
  });

  // TOTP 挂起注册:返回 base32 密钥 + otpauth URL(仅本次;扫码确认前不参与登录)
  app.post('/v1/me/totp/enroll', session, async (c) => {
    const me = await deps.admins.find(c.get('adminId'));
    const result = await deps.identity.mfa.enrollTotp({
      userId: c.get('adminId'),
      label: me?.email,
    });
    return c.json(result);
  });

  // 确认绑定:验当前验证器码 → 生效 + 整组重签恢复码(仅此一次返回明文)
  app.post('/v1/me/totp/confirm', session, jsonBody(authContracts.totpCode), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.identity.mfa.confirmTotp({
      userId: c.get('adminId'),
      code: body.code,
    });
    return c.json(result);
  });

  // 解绑:必须持有效 TOTP/恢复码(防会话被偷后一键拆防线)
  app.post('/v1/me/totp/disable', session, jsonBody(authContracts.totpCode), async (c) => {
    const body = c.req.valid('json');
    const result = await deps.identity.mfa.disableTotp({
      userId: c.get('adminId'),
      code: body.code,
    });
    if (!result.disabled) {
      throw AdminErrors.business('invalid_totp_code', {});
    }
    return c.json({ ok: true });
  });

  return app;
}
