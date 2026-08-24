import {
  Activity,
  Coins,
  Banknote,
  CalendarClock,
  ChartBar,
  Gauge,
  Gem,
  History,
  ShieldAlert,
  ShieldCheck,
  Network,
  ScrollText,
  Server,
  Store,
  Ticket,
  UserCog,
  UsersRound,
  Wallet,
  CreditCard,
  Bell,
  Megaphone,
  UserPlus,
} from 'lucide-react';

import type { NavGroup } from '@/components/shell/sidebar/nav-main';

/**
 * 管理后台 sidebar 数据（title/label 为 nav 命名空间的 i18n key，渲染处解析）。
 * permission = 该入口所需的域读权限（RBAC——docs/admin-rbac/DESIGN §2.2 路由组域归属
 * 的前端映射;无 permission = 所有角色可见）。导航过滤在 AppSidebar,权威判定在后端。
 */
export function buildSidebarItems(): NavGroup[] {
  return [
    {
      id: 1,
      label: 'groupOverview',
      items: [{ id: 'stats', title: 'dashboard', url: '/dashboard', icon: ChartBar }],
    },
    {
      id: 2,
      label: 'groupResources',
      items: [
        {
          id: 'users',
          title: 'users',
          url: '/dashboard/users',
          icon: UsersRound,
          permission: 'users:read',
        },
        {
          id: 'providers',
          title: 'providers',
          url: '/dashboard/providers',
          icon: Server,
          permission: 'catalog:read',
        },
        {
          id: 'channels',
          title: 'channels',
          url: '/dashboard/channels',
          icon: Network,
          permission: 'catalog:read',
        },
        {
          id: 'models',
          title: 'models',
          url: '/dashboard/models',
          icon: Server,
          permission: 'catalog:read',
        },
        {
          id: 'rate-cards',
          title: 'rateCards',
          url: '/dashboard/rate-cards',
          icon: Banknote,
          permission: 'catalog:read',
        },
        {
          id: 'rate-limits',
          title: 'rateLimits',
          url: '/dashboard/rate-limits',
          icon: Gauge,
          permission: 'users:read',
        },
        {
          id: 'plans',
          title: 'plans',
          url: '/dashboard/plans',
          icon: Gem,
          permission: 'plans:read',
        },
        {
          id: 'subscriptions',
          title: 'subscriptions',
          url: '/dashboard/subscriptions',
          icon: CalendarClock,
          permission: 'plans:read',
        },
        {
          id: 'channel-funds',
          title: 'channelFunds',
          url: '/dashboard/channel-funds',
          icon: Wallet,
          permission: 'funds:read',
        },
        {
          id: 'marketing',
          title: 'marketing',
          url: '/dashboard/marketing',
          icon: Megaphone,
          permission: 'growth:read',
        },
        {
          id: 'referrals',
          title: 'referrals',
          url: '/dashboard/referrals',
          icon: UserPlus,
          permission: 'growth:read',
        },
        {
          id: 'payment-orders',
          title: 'paymentOrders',
          url: '/dashboard/payment-orders',
          icon: CreditCard,
          permission: 'funds:read',
        },
      ],
    },
    {
      id: 3,
      label: 'groupEcosystem',
      items: [
        {
          id: 'model-market',
          title: 'modelMarket',
          url: '/dashboard/model-market',
          icon: Store,
          permission: 'catalog:read',
        },
      ],
    },
    {
      id: 4,
      label: 'groupRedeem',
      items: [
        {
          id: 'redeem-batches',
          title: 'redeemBatches',
          url: '/dashboard/redeem-batches',
          icon: Ticket,
          permission: 'funds:read',
        },
      ],
    },
    {
      id: 5,
      label: 'groupAudit',
      items: [
        {
          id: 'notifications',
          title: 'notifications',
          url: '/dashboard/notifications',
          icon: Bell,
          permission: 'growth:read',
        },
        {
          id: 'billing-operations',
          title: 'billingOperations',
          url: '/dashboard/billing-operations',
          icon: ShieldAlert,
          permission: 'funds:read',
        },
        {
          id: 'tracing',
          title: 'tracing',
          url: '/dashboard/tracing',
          icon: Activity,
          permission: 'ops:read',
        },
        {
          id: 'logs',
          title: 'logs',
          url: '/dashboard/logs',
          icon: ScrollText,
          permission: 'ops:read',
        },
        {
          id: 'usage-logs',
          title: 'usageLogs',
          url: '/dashboard/usage-logs',
          icon: Coins,
          permission: 'ops:read',
        },
        {
          id: 'audit-logs',
          title: 'auditLogs',
          url: '/dashboard/audit-logs',
          icon: History,
          permission: 'ops:read',
        },
      ],
    },
    {
      id: 6,
      label: 'groupSystem',
      items: [
        {
          id: 'admins',
          title: 'admins',
          url: '/dashboard/admins',
          icon: UserCog,
          permission: 'admins:read',
        },
        {
          id: 'settings',
          title: 'settings',
          url: '/dashboard/settings',
          icon: ShieldCheck,
          permission: 'settings:read',
        },
      ],
    },
  ];
}
