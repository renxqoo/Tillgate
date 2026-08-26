'use client';

import { TableCell, TableRow } from '@tillgate/ui';
import { StatusPill } from '@/components/status-pill';
import { BriefcaseIcon, UserIcon } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { fmtDateTime, formatMoney } from '@/lib/formatters';

import type { RateCardOption, AdminUserRow } from '@tillgate/api-client';

import { rateCardLabel } from '../rate-card-label';
import { useActionResult } from '@/components/action-toast';
import { UserRowActionCell } from './user-row-action-cell';

export function UserRowItem({
  user,
  rateCards,
}: {
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, setPending] = useState(false);
  const [activeDialog, setActiveDialog] = useState<
    'adjust' | 'gift' | 'password' | 'rate' | 'freeze' | null
  >(null);

  /** 解封直执行;封禁经 FreezeDialog(原因输入 + 确认,替代原生 prompt/confirm)。 */
  async function unban() {
    setPending(true);
    const { setUserStatusAction } = await import('@/server/users-actions');
    const res = await setUserStatusAction(user.id, { status: 0, freezeReason: '' });
    setPending(false);
    notify(res, t('unbanFailed'), t('unbanned'));
  }

  async function toggleEnterprise() {
    setPending(true);
    const { setUserEnterpriseAction } = await import('@/server/users-actions');
    const res = await setUserEnterpriseAction(user.id, !user.isEnterprise);
    setPending(false);
    notify(
      res,
      tc('actionFailed'),
      user.isEnterprise ? t('removedEnterprise') : t('markedEnterprise'),
    );
  }

  return (
    <TableRow>
      <TableCell className="min-w-64">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <UserIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <Link
              href={`/dashboard/users/${user.id}`}
              className="block truncate font-medium hover:underline"
            >
              {user.subject}
            </Link>
            <span className="block truncate text-sm text-muted-foreground">
              {user.displayName ?? user.email ?? `#${user.id}`}
              {user.displayName && user.email ? ` · ${user.email}` : null}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {user.status === 0 ? (
          <StatusPill tone="success" label={tc('active')} />
        ) : (
          <StatusPill
            tone="danger"
            label={t('bannedShort')}
            title={user.freezeReason ?? undefined}
          />
        )}
      </TableCell>
      <TableCell>
        {user.isEnterprise ? (
          <StatusPill tone="accent">
            <BriefcaseIcon className="size-3" /> {t('enterprise')}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">
            <UserIcon className="size-3" /> {t('personal')}
          </StatusPill>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {rateCardLabel(user, rateCards)}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {formatMoney(user.balance)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-amber-600">
        {formatMoney(user.reservedBalance)}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {formatMoney(user.availableBalance)}
      </TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(user.creditLimit)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {user.dailySpendLimit === null ? tc('unlimited') : formatMoney(user.dailySpendLimit)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : tc('never')}
      </TableCell>
      <TableCell className="w-16 text-center">
        <UserRowActionCell
          user={user}
          pending={pending}
          activeDialog={activeDialog}
          onDialogChange={setActiveDialog}
          onUnban={unban}
          onToggleEnterprise={toggleEnterprise}
          rateCards={rateCards}
        />
      </TableCell>
    </TableRow>
  );
}
