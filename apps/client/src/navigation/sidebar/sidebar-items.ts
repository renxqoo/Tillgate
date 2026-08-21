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
  // label/title 存 i18n key（nav 命名空间），渲染处（app-sidebar）统一翻译
  const groups: NavGroup[] = [
    {
      id: 1,
      label: 'console',
      items: [
        {
          id: 'dashboard',
          title: 'dashboard',
          url: '/dashboard',
          icon: LayoutDashboard,
        },
        {
          id: 'keys',
          title: 'keys',
          url: '/dashboard/keys',
          icon: KeyRound,
        },
        {
          id: 'api-guide',
          title: 'apiGuide',
          url: '/dashboard/api-guide',
          icon: BookOpenText,
        },
        {
          id: 'apps',
          title: 'apps',
          url: '/dashboard/apps',
          icon: ShieldCheck,
        },
        {
          id: 'playground',
          title: 'playground',
          url: '/dashboard/playground',
          icon: FlaskConical,
        },
        {
          id: 'invite',
          title: 'invite',
          url: '/dashboard/invite',
          icon: Users,
        },
        {
          id: 'billing',
          title: 'billing',
          url: '/dashboard/billing',
          icon: Wallet,
        },
        {
          id: 'redeem',
          title: 'redeem',
          url: '/dashboard/redeem',
          icon: Gift,
        },
        {
          id: 'subscription',
          title: 'subscription',
          url: '/dashboard/subscription',
          icon: Gem,
        },
        {
          id: 'orgs',
          title: 'orgs',
          url: '/dashboard/orgs',
          icon: Building2,
        },
        {
          id: 'usage',
          title: 'usage',
          url: '/dashboard/usage',
          icon: LineChart,
        },
        {
          id: 'transactions',
          title: 'transactions',
          url: '/dashboard/transactions',
          icon: Coins,
        },
        {
          id: 'settings',
          title: 'settings',
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
