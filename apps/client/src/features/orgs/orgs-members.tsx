'use client';

// 成员列表：行项（头像/标签）× 所有者视角的配额入口与移除按钮

import { Loader2Icon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Avatar, AvatarFallback, Button, StatusPill } from '@tillgate/ui';
import type { OrgMemberRow, OrgRow } from '@tillgate/api-client';
import { ConfirmAction } from '@/features/shared/confirm-action';
import { removeMemberAction } from '@/server/actions/orgs';
import { initials, memberLabel } from './orgs-shared';
import { QuotaCell } from './orgs-quota';

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

function MemberRow({
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

function RemoveButton({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  const t = useTranslations('orgs');
  return (
    <ConfirmAction
      confirm={t('removeConfirm', { name: member.displayName || member.email || '' })}
      action={async () => removeMemberAction(org.orgId, member.userId)}
      errorTitle={t('removeFailed')}
      success={t('removedToast')}
    >
      {({ pending, onClick }) => (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-destructive hover:text-destructive"
          disabled={pending}
          aria-label={t('removeMemberAria')}
          onClick={onClick}
        >
          {pending ? <Loader2Icon className="animate-spin" /> : <Trash2Icon className="size-4" />}
        </Button>
      )}
    </ConfirmAction>
  );
}
