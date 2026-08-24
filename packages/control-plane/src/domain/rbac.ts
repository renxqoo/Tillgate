/**
 * 管理端 RBAC 权限模型（单一真相，docs/admin-rbac/DESIGN.md §2）。
 *
 * 角色词表、权限域词表、角色→权限矩阵都只在本文件定义一次；DB 的 admins.role
 * CHECK 与 admin-api 的域守卫都是本词表的消费方。角色集是平台行为语义——
 * 改角色能力 = 发版，不做 DB 动态角色（DESIGN §1.2 / D1）。
 */
import { controlPlaneErrors } from '../errors';

/** 权限域（封闭词表：admin-api 路由组的域归属，DESIGN §2.2） */
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

/** 动作（封闭词表：HTTP 方法分派 GET/HEAD→read，其余→write） */
export const PERMISSION_ACTIONS = ['read', 'write'] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** 权限标识 `<domain>:<action>` */
export type Permission = `${PermissionDomain}:${PermissionAction}`;

/** 角色词表（封闭词表：DB CHECK admins_role_ck 与此处一致） */
export const ADMIN_ROLES = ['super_admin', 'operator', 'finance', 'support', 'viewer'] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/** 非 admins 域 = 所有业务域（管理员管理仅 super_admin 可见，DESIGN §2.4） */
const BUSINESS_DOMAINS: readonly PermissionDomain[] = PERMISSION_DOMAINS.filter(
  (domain) => domain !== 'admins',
);

/**
 * 角色 → 读/写域授权（紧凑形态；全量权限集由 permissionsOf 派生）。
 * 矩阵语义见 DESIGN §2.4：operator=运营（目录/订阅/观测/增长/设置/用户写），
 * finance=财务（资金写），support=客服（用户写，settings 不可读），viewer=只读。
 */
const ROLE_GRANTS: Readonly<
  Record<
    AdminRole,
    {
      readonly read: readonly PermissionDomain[];
      readonly write: readonly PermissionDomain[];
    }
  >
> = {
  super_admin: { read: PERMISSION_DOMAINS, write: PERMISSION_DOMAINS },
  operator: {
    read: BUSINESS_DOMAINS,
    write: ['users', 'catalog', 'plans', 'ops', 'growth', 'settings'],
  },
  finance: { read: BUSINESS_DOMAINS, write: ['funds'] },
  support: {
    read: ['users', 'funds', 'catalog', 'plans', 'ops', 'growth'],
    write: ['users'],
  },
  viewer: { read: BUSINESS_DOMAINS, write: [] },
};

const PERMISSION_SETS: ReadonlyMap<string, ReadonlySet<Permission>> = new Map(
  ADMIN_ROLES.map((role) => {
    const grants = ROLE_GRANTS[role];
    const permissions = new Set<Permission>([
      ...grants.read.map((domain) => `${domain}:read` as Permission),
      ...grants.write.map((domain) => `${domain}:write` as Permission),
    ]);
    return [role, permissions];
  }),
);

/** 角色的全量权限集（/v1/me 下发、前端导航过滤的单一事实来源） */
export function permissionsOf(role: AdminRole): readonly Permission[] {
  const set = PERMISSION_SETS.get(role);
  if (set == null) {
    // 静态词表内角色必有授权集——此分支只防矩阵构造漂移
    throw controlPlaneErrors.business('invalid_admin_role', { role });
  }
  return [...set].toSorted();
}

/** 权限判定（运行时容错：未知角色/未知权限串一律拒绝——fail-closed） */
export function can(role: string, permission: string): boolean {
  return PERMISSION_SETS.get(role)?.has(permission as Permission) ?? false;
}

/** 角色词表守卫（运行时字符串 → AdminRole；非法值抛 invalid_admin_role） */
export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

export function assertAdminRole(value: string): AdminRole {
  if (!isAdminRole(value)) {
    throw controlPlaneErrors.business('invalid_admin_role', { role: value });
  }
  return value;
}

// ══════════════════════════════════════════════════════════════════════════
// v2（ADR-0008）：动态角色 + 权限树。以下为 v2 面;上方 v1 矩阵在 admin-api
// 切换 guard(codes) 后（v2-3）整段删除,不共存出仓库。
// ══════════════════════════════════════════════════════════════════════════

/**
 * enforced 码注册表（单一真相 = 本清单;0082 种子与 admin-api guard 声明都是消费方）。
 * 规约 `<域>:<动词>`;逐端点挂码清单见 docs/admin-rbac-v2/DESIGN §2。
 * 启动对账：本清单 ⊆ DB permissions active enforced 节点,缺即拒启。
 */
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

/** v2 判定原语：一切判定（路由/菜单/按钮）的唯一入口 */
export function granted(grants: AdminGrants, code: string): boolean {
  if (grants.isSuper) return true;
  return grants.codes.includes(code);
}
