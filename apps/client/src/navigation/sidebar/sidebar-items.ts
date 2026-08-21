import {
  BookOpenText,
  Building2,
  Coins,
  Gem,
  Gift,
  KeyRound,
  LayoutDashboard,
  LineChart,
  Settings,
  ShieldCheck,
  Wallet,
  Users,
  FlaskConical,
} from 'lucide-react';

import type { NavGroup } from '@ai-gateway/ui/components/shell/sidebar/nav-main';

/** 用户面板 sidebar 数据。拆分后用户面板无管理入口（管理后台在 apps/admin 独立部署）。 */
export interface SidebarOptions {
  /** 邀请功能开关（marketing_settings 两项激励任一 > 0）；缺省 true（保守：入口在，页面空态兜底） */
  referralEnabled?: boolean;
}

export function buildSidebarItems(opts: SidebarOptions = {}): NavGroup[] {
  const groups: NavGroup[] = [
    {
      id: 1,
      label: '用户面板',
      items: [
        {
          id: 'dashboard',
          title: '仪表盘',
          url: '/dashboard',
          icon: LayoutDashboard,
        },
        {
          id: 'keys',
          title: 'API Key',
          url: '/dashboard/keys',
          icon: KeyRound,
        },
        {
          id: 'api-guide',
          title: '接口调用',
          url: '/dashboard/api-guide',
          icon: BookOpenText,
        },
        {
          id: 'apps',
          title: '应用',
          url: '/dashboard/apps',
          icon: ShieldCheck,
        },
        {
          id: 'playground',
          title: '操练场',
          url: '/dashboard/playground',
          icon: FlaskConical,
        },
        {
          id: 'invite',
          title: '邀请返利',
          url: '/dashboard/invite',
          icon: Users,
        },
        {
          id: 'billing',
          title: '在线充值',
          url: '/dashboard/billing',
          icon: Wallet,
        },
        {
          id: 'redeem',
          title: '充值码',
          url: '/dashboard/redeem',
          icon: Gift,
        },
        {
          id: 'subscription',
          title: '套餐订阅',
          url: '/dashboard/subscription',
          icon: Gem,
        },
        {
          id: 'orgs',
          title: '组织',
          url: '/dashboard/orgs',
          icon: Building2,
        },
        {
          id: 'usage',
          title: '用量',
          url: '/dashboard/usage',
          icon: LineChart,
        },
        {
          id: 'transactions',
          title: '账单流水',
          url: '/dashboard/transactions',
          icon: Coins,
        },
        {
          id: 'settings',
          title: '设置',
          url: '/dashboard/settings',
          icon: Settings,
        },
      ],
    },
  ];
  return opts.referralEnabled === false
    ? groups.map((g) => ({ ...g, items: g.items.filter((i) => i.id !== 'invite') }))
    : groups;
}
