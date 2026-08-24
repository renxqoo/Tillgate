import type { AdminMeInfo } from '@tokenlens/api-client';
import { adminApi } from './admin-api';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getTranslations } from 'next-intl/server';

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
 * 能从 admin-api 的 /v1/me 拿到管理员信息,即证明持有效会话。拿不到 → 重定向登录。
 * React cache 去重:layout 守卫与页面级 requirePermission 同请求只打一次 /v1/me。
 */
export const requireAdmin = cache(async (): Promise<AdminMeInfo> => {
  if (process.env.DEV_FAKE_ME === '1' && process.env.NODE_ENV !== 'production') {
    return {
      id: 99,
      email: 'admin@studio-admin.dev',
      displayName: 'Admin',
      lastLoginAt: null,
      role: { id: 1, code: 'super_admin', name: '超级管理员', isSuper: true },
      permissions: [
        'users:read',
        'users:update',
        'users:set-password',
        'funds:read',
        'funds:adjust',
        'funds:recharge',
        'funds:gift',
        'funds:close',
        'funds:revoke',
        'funds:create',
        'funds:retry',
        'funds:abandon',
        'catalog:read',
        'catalog:create',
        'catalog:update',
        'catalog:delete',
        'catalog:restore',
        'catalog:test',
        'catalog:import',
        'catalog:refresh',
        'catalog:bind',
        'plans:read',
        'plans:create',
        'plans:update',
        'plans:delete',
        'plans:renew',
        'plans:cancel',
        'plans:change',
        'plans:grant',
        'ops:read',
        'growth:read',
        'growth:create',
        'growth:update',
        'growth:delete',
        'growth:test',
        'settings:read',
        'settings:update',
        'admins:read',
        'admins:create',
        'admins:update',
        'admins:delete',
      ],
    };
  }
  const me = await adminApi().getAdminMe();
  if (!me) redirect('/login');
  return me;
});

/**
 * 页面级权限兜底（动态 RBAC）:导航已按 permissions 过滤,直访 URL 时在此重定向概览。
 * 权威判定在 admin-api guard(code)——此处仅为 UX,Server Actions 不重复检查。
 */
export async function requirePermission(code: string): Promise<AdminMeInfo> {
  const me = await requireAdmin();
  if (!me.permissions?.includes(code)) redirect('/dashboard');
  return me;
}

/** 按钮显隐原语（与后端 can(code) 同源——消费 /v1/me permissions） */
export function hasPerm(me: { permissions?: string[] }, code: string): boolean {
  return me.permissions?.includes(code) ?? false;
}

/** 解析后的菜单组（label 已 i18n;path/icon 供 sidebar 渲染） */
export interface ResolvedMenuGroup {
  readonly label: string | null;
  readonly items: readonly {
    readonly name: string;
    readonly path: string | null;
    readonly icon: string | null;
  }[];
}

/**
 * 菜单树解析（layout 消费;/v1/me/menus 后端驱动 + i18n 解析——i18n_key 是根限定键
 * （内置节点 'nav.xxx'）,用根命名空间解析;未命中回落 DB name）。React cache:
 * 同请求与 requireAdmin 各只打一次接口。
 */
export const requireMenus = cache(async (): Promise<ResolvedMenuGroup[]> => {
  if (process.env.DEV_FAKE_ME === '1' && process.env.NODE_ENV !== 'production') {
    return [];
  }
  const t = await getTranslations();
  const data = await adminApi().getMyMenus();
  return (data.groups ?? []).map((group) => ({
    label: group.i18nKey != null && t.has(group.i18nKey) ? t(group.i18nKey) : group.name,
    items: group.items.map((item) => ({
      name: item.i18nKey != null && t.has(item.i18nKey) ? t(item.i18nKey) : item.name,
      path: item.path,
      icon: item.icon,
    })),
  }));
});
