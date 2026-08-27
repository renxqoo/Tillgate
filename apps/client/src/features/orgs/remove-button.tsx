'use client';

import { Loader2Icon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@tillgate/ui';
import type { OrgMemberRow, OrgRow } from '@tillgate/api-client';
import { ConfirmAction } from '@/features/shared/confirm-action';
import { removeMemberAction } from '@/server/actions/orgs';

export function RemoveButton({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
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
