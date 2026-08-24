'use client';

import { Button } from '@tillgate/ui';
import { DownloadIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminUserRow } from '@tillgate/api-client';

export function UsersExport({ users }: { readonly users: ReadonlyArray<AdminUserRow> }) {
  const t = useTranslations('users');
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        const lines = [
          'id\tsubject\temail\tdisplayName\tstatus\taccountType\tsettledBalance\treservedBalance\tavailableBalance\tcreditLimit\tdailySpendLimit\trateCard',
        ];
        for (const u of users) {
          lines.push(
            `${u.id}\t${u.subject}\t${u.email ?? ''}\t${u.displayName ?? ''}\t${u.status}\t${u.isEnterprise ? t('enterprise') : t('personal')}\t${u.balance}\t${u.reservedBalance}\t${u.availableBalance}\t${u.creditLimit}\t${u.dailySpendLimit ?? ''}\t${u.rateCardName ?? ''}`,
          );
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/tab-separated-values' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `users-${new Date().toISOString().slice(0, 10)}.tsv`;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      <DownloadIcon />
      Export
    </Button>
  );
}
