import {
  Banknote,
  ChartBar,
  History,
  KeyRound,
  type LucideIcon,
  Network,
  ScrollText,
  Server,
  Ticket,
  UsersRound,
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

/** 管理后台 sidebar 数据 */
export function buildSidebarItems(): NavGroup[] {
  return [
    {
      id: 1,
      label: "运营总览",
      items: [
        { id: "stats", title: "仪表盘", url: "/dashboard", icon: ChartBar },
      ],
    },
    {
      id: 2,
      label: "资源管理",
      items: [
        { id: "users", title: "用户", url: "/dashboard/users", icon: UsersRound },
        { id: "providers", title: "供应商", url: "/dashboard/providers", icon: Server },
        { id: "channels", title: "渠道", url: "/dashboard/channels", icon: Network },
        { id: "models", title: "模型映射", url: "/dashboard/models", icon: Server },
        { id: "rate-cards", title: "费率卡", url: "/dashboard/rate-cards", icon: Banknote },
      ],
    },
    {
      id: 3,
      label: "充值码",
      items: [
        { id: "redeem-batches", title: "批次管理", url: "/dashboard/redeem-batches", icon: Ticket },
      ],
    },
    {
      id: 4,
      label: "审计",
      items: [
        { id: "logs", title: "请求日志", url: "/dashboard/logs", icon: ScrollText },
        { id: "audit-logs", title: "操作审计", url: "/dashboard/audit-logs", icon: History },
      ],
    },
  ];
}
