import type { AdminMeInfo } from '@tokenlens/api-client';
import { adminApi } from './admin-api';
import { redirect } from 'next/navigation';

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
 */
export async function requireAdmin(): Promise<AdminMeInfo> {
  if (process.env.DEV_FAKE_ME === '1' && process.env.NODE_ENV !== 'production') {
    return {
      id: 99,
      email: 'admin@studio-admin.dev',
      displayName: 'Admin',
      lastLoginAt: null,
    };
  }
  const me = await adminApi().getAdminMe();
  if (!me) redirect('/login');
  return me;
}
