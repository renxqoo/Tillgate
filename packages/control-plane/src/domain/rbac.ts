/**
 * 管理端 动态 RBAC 权限模型。
 *
 * enforced 码注册表 = 种子(0082)与 admin-api guard 声明的单一真相;动态角色/授权
 * 住 DB（roles/role_permissions/permissions 树）。
 */

/**
 * enforced 码注册表（单一真相 = 本清单;0082 种子与 admin-api guard 声明都是消费方）。
 * 规约 `<域>:<动词>`。
 * 启动对账：本清单 ⊆ DB permissions active enforced 节点,缺即拒启。
 */
/** 权限域词表（8 域封闭——路由组域归属） */
export const PERMISSION_DOMAINS = [
  'users',
  'funds',
  'catalog',
  'plans',
  'ops',
  'growth',
  'settings',
  'admins',
] as const;

export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export const ENFORCED_CODES = [
  // users
  'users:read',
  'users:update',
  'users:set-password',
  // funds
  'funds:read',
  'funds:adjust',
  'funds:recharge',
  'funds:gift',
  'funds:close',
  'funds:revoke',
  'funds:create',
  'funds:retry',
  'funds:floor',
  'funds:fx',
  'funds:abandon',
  // catalog
  'catalog:read',
  'catalog:create',
  'catalog:update',
  'catalog:delete',
  'catalog:restore',
  'catalog:test',
  'catalog:import',
  'catalog:refresh',
  'catalog:bind',
  // plans
  'plans:read',
  'plans:create',
  'plans:update',
  'plans:delete',
  'plans:renew',
  'plans:cancel',
  'plans:change',
  'plans:grant',
  // ops（无写端点,域只读）
  'ops:read',
  // growth
  'growth:read',
  'growth:create',
  'growth:update',
  'growth:delete',
  'growth:test',
  // settings
  'settings:read',
  'settings:update',
  // 第三方集成凭据写入（独立码——出网点收窄）
  'settings:integrations',
  // admins（admins/roles/permissions 管理面共用）
  'admins:read',
  'admins:create',
  'admins:update',
  'admins:delete',
] as const;

export type EnforcedCode = (typeof ENFORCED_CODES)[number];

const ENFORCED_SET: ReadonlySet<string> = new Set(ENFORCED_CODES);

/** 码在 enforced 注册表内（guard 工厂构建期校验——未知码拒构建,不静默放行） */
export function isEnforcedCode(code: string): code is EnforcedCode {
  return ENFORCED_SET.has(code);
}

/** 会话授权面（属主回查一条 join 的产物;isSuper 短路全量） */
export interface AdminGrants {
  readonly isSuper: boolean;
  readonly codes: readonly string[];
}

/** 属主回查完整面：账号状态 + 授权（session 中间件单查询消费） */
export interface AdminAccess {
  readonly status: number;
  readonly grants: AdminGrants;
}

/** 判定原语：一切判定（路由/菜单/按钮）的唯一入口 */
export function granted(grants: AdminGrants, code: string): boolean {
  if (grants.isSuper) return true;
  return grants.codes.includes(code);
}
