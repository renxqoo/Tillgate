/**
 * 会话守卫（受保护页权威校验；middleware 只做 cookie 存在性快速门卫）。
 * getMe() 吞错返 null（api-client facade 语义）——任何失败（未登录/后端不可达）
 * 都按无会话处理跳登录页。
 */
import { redirect } from 'next/navigation';

import type { ClientApiClient, MeInfo } from '@tokenlens/api-client';

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

/**
 * dashboard 族页面必须登录：401/后端不可达 → redirect('/login')。
 * DEV_FAKE_ME=1（非生产）注入演示会话——离线截图/演示用，跳过后端调用。
 */
export async function requireMe(api: ClientApiClient = createClientApi()): Promise<MeInfo> {
  if (isDevFakeMe()) {
    return {
      id: 1,
      subject: 'demo_user',
      email: 'demo@tokenlens.dev',
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
  const me = await api.getMe();
  if (!me) redirect('/login');
  return me;
}
