import {
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
} from "lucide-react";

import type { NavGroup } from "@ai-gateway/ui/components/shell/sidebar/nav-main";


/** 用户面板 sidebar 数据。拆分后用户面板无管理入口（管理后台在 apps/admin 独立部署）。 */
export function buildSidebarItems(): NavGroup[] {
  return [
    {
      id: 1,
      label: "用户面板",
      items: [
        {
          id: "dashboard",
          title: "仪表盘",
          url: "/dashboard",
          icon: LayoutDashboard,
        },
        {
          id: "keys",
          title: "API Key",
          url: "/dashboard/keys",
          icon: KeyRound,
        },
        {
          id: "apps",
          title: "应用",
          url: "/dashboard/apps",
          icon: ShieldCheck,
        },
        {
          id: "playground",
          title: "操练场",
          url: "/dashboard/playground",
          icon: FlaskConical,
        },
        {
          id: "invite",
          title: "邀请返利",
          url: "/dashboard/invite",
          icon: Users,
        },
        {
          id: "billing",
          title: "在线充值",
          url: "/dashboard/billing",
          icon: Wallet,
        },
        {
          id: "redeem",
          title: "充值码",
          url: "/dashboard/redeem",
          icon: Gift,
        },
        {
          id: "subscription",
          title: "套餐订阅",
          url: "/dashboard/subscription",
          icon: Gem,
        },
        {
          id: "orgs",
          title: "组织",
          url: "/dashboard/orgs",
          icon: Building2,
        },
        {
          id: "usage",
          title: "用量",
          url: "/dashboard/usage",
          icon: LineChart,
        },
        {
          id: "transactions",
          title: "账单流水",
          url: "/dashboard/transactions",
          icon: Coins,
        },
        {
          id: "settings",
          title: "设置",
          url: "/dashboard/settings",
          icon: Settings,
        },
      ],
    },
  ];
}
