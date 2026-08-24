/**
 * 组织呈现：成员资格视图 + 组织活跃订阅富化（app-face join，accounts G1 注释明示
 * 「订阅富化归 app 组合」）→ /v1/orgs wire 行。剩余额度 = max(quota-used-reserved, 0)。
 */
import { Decimal } from '@tillgate/billing';

/** 组织活跃订阅富化行（subscription-read 适配器产出） */
export interface OrgSubscriptionInfo {
  subscriptionId: number;
  planName: string | null;
  quantity: number | null;
  quotaAmount: string | null;
  usedAmount: string | null;
  reservedAmount: string | null;
}

export interface MembershipView {
  orgId: number;
  orgName: string;
  role: string;
}

/** api-client OrgRow 口径 */
export interface OrgRow {
  orgId: number;
  name: string;
  role: string;
  subscriptionId: number | null;
  planName: string | null;
  quantity: number | null;
  quotaAmount: string | null;
  usedAmount: string | null;
  reservedAmount: string | null;
  remainingAmount: string;
}

export function toOrgRows(
  memberships: readonly MembershipView[],
  subs: ReadonlyMap<number, OrgSubscriptionInfo>,
): OrgRow[] {
  return memberships.map((m) => {
    const sub = subs.get(m.orgId);
    const remaining =
      sub != null && sub.quotaAmount != null
        ? Decimal.max(
            new Decimal(sub.quotaAmount)
              .minus(sub.usedAmount ?? '0')
              .minus(sub.reservedAmount ?? '0'),
            new Decimal(0),
          ).toString()
        : '0';
    return {
      orgId: m.orgId,
      name: m.orgName,
      role: m.role,
      subscriptionId: sub?.subscriptionId ?? null,
      planName: sub?.planName ?? null,
      quantity: sub?.quantity ?? null,
      quotaAmount: sub?.quotaAmount ?? null,
      usedAmount: sub?.usedAmount ?? null,
      reservedAmount: sub?.reservedAmount ?? null,
      remainingAmount: remaining,
    };
  });
}
