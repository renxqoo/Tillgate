'use client';

import { useTranslations } from 'next-intl';
import { Avatar, AvatarFallback, StatusPill } from '@tillgate/ui';
import type { OrgMemberRow, OrgRow } from '@tillgate/api-client';
import { initials, memberLabel } from './orgs-shared';
import { QuotaCell } from './orgs-quota';
import { RemoveButton } from './remove-button';

export function MemberRow({
  org,
  member,
  isOwner,
}: {
  org: OrgRow;
  member: OrgMemberRow;
  isOwner: boolean;
}) {
  const t = useTranslations('orgs');
  const isOrgOwner = member.role === 'owner';
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <Avatar className="size-7">
        <AvatarFallback className="text-xs">{initials(member)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{memberLabel(member)}</div>
        {member.email && member.email !== memberLabel(member) ? (
          <div className="truncate text-xs text-muted-foreground">{member.email}</div>
        ) : null}
      </div>
      {(() => {
        if (isOrgOwner) return <StatusPill tone="info">{t('roleOwner')}</StatusPill>;
        if (isOwner) {
          return (
            <>
              <QuotaCell org={org} member={member} />
              <RemoveButton org={org} member={member} />
            </>
          );
        }
        return null;
      })()}
    </li>
  );
}
