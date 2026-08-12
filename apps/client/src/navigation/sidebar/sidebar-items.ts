import {
  Coins,
  Gift,
  KeyRound,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  Settings,
  ShieldCheck,
} from "lucide-react";

export type NavBadge = "new" | "soon";

interface NavItemBase {
  id: string;
  title: string;
  icon?: LucideIcon;
  badge?: NavBadge;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavMainLinkItem extends NavItemBase {
  url: string;
  subItems?: never;
}

export interface NavMainParentItem extends NavItemBase {
  subItems: NavSubItem[];
}

export type NavMainItem = NavMainLinkItem | NavMainParentItem;

export interface NavSubItem {
  id: string;
  title: string;
  url: string;
  icon?: LucideIcon;
  disabled?: boolean;
  newTab?: boolean;
}

export interface NavGroup {
  id: number;
  label?: string;
  items: NavMainItem[];
}

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
          id: "redeem",
          title: "充值码",
          url: "/dashboard/redeem",
          icon: Gift,
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
