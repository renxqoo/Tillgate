'use client';

// 成员列表：行项（头像/标签）× 所有者视角的配额入口与移除按钮

import { useTranslations } from 'next-intl';
import type { OrgMemberRow, OrgRow } from '@tillgate/api-client';
import { MemberRow } from './member-row';

export function MemberList({
  org,
  members,
  isOwner,
}: {
  org: OrgRow;
  members: OrgMemberRow[];
  isOwner: boolean;
}) {
  const t = useTranslations('orgs');
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        {t('membersLabel', { count: members.length })}
      </p>
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noMembers')}</p>
      ) : (
        <ul className="space-y-1.5">
          {members.map((m) => (
            <MemberRow key={m.userId} org={org} member={m} isOwner={isOwner} />
          ))}
        </ul>
      )}
    </div>
  );
}
