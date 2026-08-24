/**
 * 会话守卫（受保护页权威校验；middleware 只做 cookie 存在性快速门卫）。
 * getMe() 吞错返 null（api-client facade 语义）——任何失败（未登录/后端不可达）
 * 都按无会话处理跳登录页。
 */
import { redirect } from 'next/navigation';

import type { ClientApiClient, MeInfo } from '@tillgate/api-client';

import { isDevFakeMe } from '@/config/dev';

import type { SidebarUser } from '@/features/shell/types';

import { createClientApi } from './api';

/** 侧栏用户投影（me 富信息只取展示所需字段） */
export function userFromMe(me: MeInfo): SidebarUser {
  return {
    name: me.displayName || me.subject,
    email: me.email ?? '',
  };
}

/** DEV_FAKE_ME=1（非生产）演示会话——离线截图/演示用，跳过后端调用 */
function fakeMe(): MeInfo {
  return {
    id: 1,
    subject: 'demo_user',
    email: 'demo@tillgate.dev',
    displayName: 'Demo Account',
    rateCardId: 1,
    rateCardName: 'Standard ×1.0',
    accounts: [
      {
        id: 'demo-cny',
        kind: 'user',
        code: null,
        currency: 'CNY',
        balance: '4321.50',
        inFlight: '0',
        creditLimit: '0',
        status: 'active',
      },
    ],
    status: 0,
    isEnterprise: false,
    rpmLimit: 2000,
    tpmLimit: 1_000_000,
    lastLoginAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

/**
 * 未登录可达页（营销首页）的登录态探测：401/失败一律返回 null（不重定向）。
 * DEV_FAKE_ME=1 时注入演示会话，与 requireMe 同源。
 */
export async function optionalMe(api: ClientApiClient = createClientApi()): Promise<MeInfo | null> {
  if (isDevFakeMe()) return fakeMe();
  return api.getMe();
}

/**
 * dashboard 族页面必须登录：401/后端不可达 → redirect('/login')。
 * DEV_FAKE_ME=1（非生产）注入演示会话——离线截图/演示用，跳过后端调用。
 */
export async function requireMe(api: ClientApiClient = createClientApi()): Promise<MeInfo> {
  if (isDevFakeMe()) {
    return fakeMe();
  }
  const me = await api.getMe();
  if (!me) redirect('/login');
  return me;
}
