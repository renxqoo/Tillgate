import type { AdminMeInfo } from '@tokenlens/api-client';
import { adminApi } from './admin-api';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import type { SidebarUser } from '@/components/shell/sidebar/app-sidebar';

export function userFromAdminMe(me: AdminMeInfo): SidebarUser {
  return {
    name: me.displayName || me.email,
    email: me.email,
    avatar: '',
  };
}

/**
 * 后台守卫：必须有有效管理员会话。
 *
 * 拆分后不再依赖 role 字段：能从 admin-api 的 /v1/me 拿到管理员信息，
 * 即证明持有有效管理员会话（admin-api 已用 adminAuthMiddleware 守护，仅 ag_admin_session
 * + ADMIN_JWT_SECRET 签发的 type='admin' token 能通过）。拿不到 → 重定向登录。
 * React cache 去重：layout 守卫与页面级 requirePermission 同请求只打一次 /v1/me。
 */
export const requireAdmin = cache(async (): Promise<AdminMeInfo> => {
  if (process.env.DEV_FAKE_ME === '1' && process.env.NODE_ENV !== 'production') {
    return {
      id: 99,
      email: 'admin@studio-admin.dev',
      displayName: 'Admin',
      lastLoginAt: null,
      // 开发旁路与生产形态同形：super_admin 全权限（权限矩阵单一真相在后端 domain/rbac）
      role: 'super_admin',
      permissions: [
        'users:read',
        'users:write',
        'funds:read',
        'funds:write',
        'catalog:read',
        'catalog:write',
        'plans:read',
        'plans:write',
        'ops:read',
        'ops:write',
        'growth:read',
        'growth:write',
        'settings:read',
        'settings:write',
        'admins:read',
        'admins:write',
      ],
    };
  }
  const me = await adminApi().getAdminMe();
  if (!me) redirect('/login');
  return me;
});

/**
 * 页面级权限兜底（RBAC）：导航已按 permissions 过滤,直访 URL 时在此重定向概览。
 * 权威判定在 admin-api 域守卫（403）——此处仅为 UX,Server Actions 不重复检查。
 */
export async function requirePermission(permission: string): Promise<AdminMeInfo> {
  const me = await requireAdmin();
  if (!me.permissions?.includes(permission)) redirect('/dashboard');
  return me;
}
