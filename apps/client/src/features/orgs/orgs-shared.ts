// 组织管理共享件：数据契约类型 + 金额/占比/成员标签的纯展示派生

import type { OrgInvitationSummary, OrgMemberRow, OrgRow } from '@tillgate/api-client';
import { formatMoney } from '@/features/shared/format';

export interface OrgWithMembers {
  org: OrgRow;
  members: OrgMemberRow[];
  invitations: OrgInvitationSummary[];
}

/** 金额展示去尾零（min 2 位保证下安全：整数金额形如 ¥100.00 → ¥100）。 */
export function fmtYuan(value: string, locale: string): string {
  return formatMoney(value, locale).replace(/\.?0+$/, '');
}

/** 已用占比（0-100），仅用于进度条展示。 */
export function usagePercent(used: string, quota: string): number {
  const u = Number(used);
  const q = Number(quota);
  if (!Number.isFinite(u) || !Number.isFinite(q) || q <= 0) return 0;
  return Math.min(100, Math.max(0, (u / q) * 100));
}

export function parseNullableMoney(v: string, invalidMessage: string): string | null {
  const value = v.trim();
  if (value === '') return null;
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(invalidMessage);
  return value;
}

export function memberLabel(m: OrgMemberRow): string {
  return m.displayName || m.email || `#${m.userId}`;
}

export function initials(m: OrgMemberRow): string {
  const label = memberLabel(m);
  const ch = label.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}
