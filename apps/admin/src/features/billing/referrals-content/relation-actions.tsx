'use client';

import { DropdownMenuItem, RowActions } from '@tillgate/ui';
import { useTransition } from 'react';
import { BanIcon, CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useActionResult } from '@/components/action-toast';

import { setRelationStatusAction } from '@/server/referrals-actions';
import type { ReferralRelationRow } from './relations-shared';

export function RelationActions({ row }: { row: ReferralRelationRow }) {
  const t = useTranslations('referrals');
  const tc = useTranslations('common');
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const banned = row.status === 1;
  let actionIcon = <BanIcon className="size-4" />;
  if (pending) actionIcon = <Loader2Icon className="size-4 animate-spin" />;
  else if (banned) actionIcon = <CheckCircle2Icon className="size-4" />;
  return (
    <RowActions label={tc('actions')}>
      <DropdownMenuItem
        variant={banned ? 'default' : 'destructive'}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              await setRelationStatusAction(row.id, banned ? 0 : 1);
              notify(
                {} as { error?: string },
                tc('actionFailed'),
                banned ? t('payoutResumed') : t('bannedToast'),
              );
            } catch (error) {
              notify({ error: error instanceof Error ? error.message : tc('actionFailed') });
            }
          })
        }
      >
        {actionIcon}
        {banned ? t('resume') : t('ban')}
      </DropdownMenuItem>
    </RowActions>
  );
}
