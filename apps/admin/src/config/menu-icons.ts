/**
 * 菜单图标注册表：DB 权限树存 lucide 图标名,此处名→组件映射（未知名兜底默认图标）。
 * 新增种子图标时在此登记（名字集与 0082 迁移种子的 icon 列一致）。
 */
import {
  Activity,
  Banknote,
  Bell,
  CalendarClock,
  ChartBar,
  Coins,
  CreditCard,
  Gauge,
  Gem,
  History,
  ListTree,
  Megaphone,
  Network,
  Plug,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  Store,
  Ticket,
  UserCog,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

const REGISTRY: Record<string, LucideIcon> = {
  Activity,
  Banknote,
  Bell,
  CalendarClock,
  ChartBar,
  Coins,
  CreditCard,
  Gauge,
  Gem,
  History,
  ListTree,
  Megaphone,
  Network,
  Plug,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  Store,
  Ticket,
  UserCog,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
};

/** 图标名 → 组件;未知名兜底（DB 任意字符串不炸渲染） */
export function menuIconOf(name?: string | null | undefined): LucideIcon {
  return (name != null && REGISTRY[name]) || ChartBar;
}
