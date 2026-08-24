'use client';

// 组织区块：头部（角色/套餐/席位）+ 配额进度条 + 成员列表 + 待处理邀请

import { Building2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Progress, StatusPill } from '@tillgate/ui';
import { fmtYuan, usagePercent, type OrgWithMembers } from './orgs-shared';
import { MemberList } from './orgs-members';
import { InviteButton, PendingInvitations } from './orgs-invite';

// 组织区块：所有者/成员双角色 × 成员/邀请/订阅多维分支交织，拆分子组件需独立 UI 契约裁决
// eslint-disable-next-line complexity -- 存量棘轮（铁律 22⑥）：超限源于角色×区块的组合分支，触碰不新增
export function OrgSection({ org, members, invitations }: OrgWithMembers) {
  const t = useTranslations('orgs');
  const locale = useLocale();
  const isOwner = org.role === 'owner';
  const active = members.filter((m) => m.status === 0);
  const hasSub = org.subscriptionId != null;

  return (
    <section className="space-y-4 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Building2Icon className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold">{org.name}</h3>
              <StatusPill tone={isOwner ? 'info' : 'neutral'}>
                {isOwner ? t('roleOwner') : t('roleMember')}
              </StatusPill>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {hasSub ? (
                <>
                  {org.planName}
                  {org.quantity != null ? ` · ${t('seatsShort', { count: org.quantity })}` : ''}
                  {org.quantity != null
                    ? ` · ${t('membersWithQuota', { count: active.length, total: org.quantity })}`
                    : ` · ${t('membersLine', { count: active.length })}`}
                </>
              ) : (
                t('noPlan')
              )}
            </p>
          </div>
        </div>
        {isOwner ? (
          <InviteButton
            org={org}
            seatsLeft={org.quantity != null ? org.quantity - active.length : null}
          />
        ) : null}
      </div>

      {hasSub && org.quotaAmount != null && org.usedAmount != null ? (
        <div>
          <Progress value={usagePercent(org.usedAmount, org.quotaAmount)} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('quotaUsed', {
              used: fmtYuan(org.usedAmount, locale),
              quota: fmtYuan(org.quotaAmount, locale),
            })}
            {org.remainingAmount != null
              ? ` · ${t('quotaRemaining', { amount: fmtYuan(org.remainingAmount, locale) })}`
              : ''}
          </p>
        </div>
      ) : null}

      {isOwner && !hasSub ? (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {t('noPlanHint')}
        </p>
      ) : null}

      <MemberList org={org} members={active} isOwner={isOwner} />

      {isOwner && invitations.length > 0 ? (
        <PendingInvitations org={org} invitations={invitations} />
      ) : null}
    </section>
  );
}
