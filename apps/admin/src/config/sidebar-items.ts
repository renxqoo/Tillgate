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
  UsersRound,
  Wallet,
  CreditCard,
  Bell,
  Megaphone,
  UserPlus,
} from 'lucide-react';

import type { NavGroup } from '@/components/shell/sidebar/nav-main';

/** 管理后台 sidebar 数据（title/label 为 nav 命名空间的 i18n key，渲染处解析） */
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
        { id: 'users', title: 'users', url: '/dashboard/users', icon: UsersRound },
        { id: 'providers', title: 'providers', url: '/dashboard/providers', icon: Server },
        { id: 'channels', title: 'channels', url: '/dashboard/channels', icon: Network },
        { id: 'models', title: 'models', url: '/dashboard/models', icon: Server },
        { id: 'rate-cards', title: 'rateCards', url: '/dashboard/rate-cards', icon: Banknote },
        { id: 'rate-limits', title: 'rateLimits', url: '/dashboard/rate-limits', icon: Gauge },
        { id: 'settings', title: 'settings', url: '/dashboard/settings', icon: ShieldCheck },
        { id: 'plans', title: 'plans', url: '/dashboard/plans', icon: Gem },
        {
          id: 'subscriptions',
          title: 'subscriptions',
          url: '/dashboard/subscriptions',
          icon: CalendarClock,
        },
        {
          id: 'channel-funds',
          title: 'channelFunds',
          url: '/dashboard/channel-funds',
          icon: Wallet,
        },
        { id: 'marketing', title: 'marketing', url: '/dashboard/marketing', icon: Megaphone },
        { id: 'referrals', title: 'referrals', url: '/dashboard/referrals', icon: UserPlus },
        {
          id: 'payment-orders',
          title: 'paymentOrders',
          url: '/dashboard/payment-orders',
          icon: CreditCard,
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
        },
        {
          id: 'billing-operations',
          title: 'billingOperations',
          url: '/dashboard/billing-operations',
          icon: ShieldAlert,
        },
        { id: 'tracing', title: 'tracing', url: '/dashboard/tracing', icon: Activity },
        { id: 'logs', title: 'logs', url: '/dashboard/logs', icon: ScrollText },
        { id: 'usage-logs', title: 'usageLogs', url: '/dashboard/usage-logs', icon: Coins },
        { id: 'audit-logs', title: 'auditLogs', url: '/dashboard/audit-logs', icon: History },
      ],
    },
  ];
}
