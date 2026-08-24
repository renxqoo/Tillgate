'use client';

import type * as React from 'react';
import { StatusPill } from '@/components/status-pill';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  RowActions,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tokenlens/ui';
import { useState, useTransition } from 'react';
import Link from 'next/link';

import {
  BanknoteIcon,
  BriefcaseIcon,
  EyeIcon,
  GiftIcon,
  KeyRoundIcon,
  Loader2Icon,
  PencilIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  UserIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { fmtDateTime, formatMoney } from '@/lib/formatters';

import { AdjustDialog, FreezeDialog, GiftDialog, PasswordDialog } from './user-dialogs';
import type { RateCardOption, AdminUserRow } from '@tokenlens/api-client';
import { useActionResult } from '@/components/action-toast';

export function UsersContent({
  users,
  rateCards,
}: {
  readonly users: ReadonlyArray<AdminUserRow>;
  readonly rateCards: ReadonlyArray<RateCardOption>;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tc('account')}</TableHead>
          <TableHead className="w-20">{tc('status')}</TableHead>
          <TableHead className="w-20">{tc('type')}</TableHead>
          <TableHead>{t('rateCard')}</TableHead>
          <TableHead className="text-right">{t('settledBalance')}</TableHead>
          <TableHead className="text-right">{t('reservedBalance')}</TableHead>
          <TableHead className="text-right">{t('availableBalance')}</TableHead>
          <TableHead className="text-right">{tc('creditLimit')}</TableHead>
          <TableHead className="text-right">{tc('dailySpendLimit')}</TableHead>
          <TableHead className="w-44">{tc('lastLogin')}</TableHead>
          <TableHead className="w-16 text-center">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
              {t('noMatch')}
            </TableCell>
          </TableRow>
        ) : (
          users.map((u) => <UserRowItem key={u.id} user={u} rateCards={rateCards} />)
        )}
      </TableBody>
    </Table>
  );
}

function UserRowItem({
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
      <TableCell className="text-xs text-muted-foreground">{user.rateCardName ?? '—'}</TableCell>
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
        <RowActions label={tc('actions')}>
          <DropdownMenuItem onClick={() => setActiveDialog('adjust')}>
            <ScaleIcon /> {t('adjust')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setActiveDialog('gift')}>
            <GiftIcon /> {t('gift')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setActiveDialog('password')}>
            <KeyRoundIcon /> {t('setPassword')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setActiveDialog('rate')}>
            <BanknoteIcon /> {t('bindRateCard')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={pending} onClick={toggleEnterprise}>
            {user.isEnterprise ? <UserIcon /> : <BriefcaseIcon />}
            {user.isEnterprise ? t('removeEnterprise') : t('setEnterprise')}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link prefetch={false} href={`/dashboard/users/${user.id}`} />}>
            <EyeIcon /> {tc('detail')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant={user.status === 0 ? 'destructive' : 'default'}
            disabled={pending}
            onClick={user.status === 0 ? () => setActiveDialog('freeze') : unban}
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {!pending && user.status === 0 && <ShieldOffIcon />}
            {!pending && user.status !== 0 && <ShieldCheckIcon />}
            {user.status === 0 ? t('ban') : t('unban')}
          </DropdownMenuItem>
        </RowActions>
        <AdjustDialog
          user={user}
          trigger={null}
          open={activeDialog === 'adjust'}
          onOpenChange={(open) => !open && setActiveDialog(null)}
        />
        <FreezeDialog
          user={user}
          open={activeDialog === 'freeze'}
          onOpenChange={(open) => !open && setActiveDialog(null)}
        />
        <GiftDialog
          user={user}
          trigger={null}
          open={activeDialog === 'gift'}
          onOpenChange={(open) => !open && setActiveDialog(null)}
        />
        <PasswordDialog
          user={user}
          trigger={null}
          open={activeDialog === 'password'}
          onOpenChange={(open) => !open && setActiveDialog(null)}
        />
        <BindRateCardDialog
          user={user}
          rateCards={rateCards}
          trigger={null}
          open={activeDialog === 'rate'}
          onOpenChange={(open) => !open && setActiveDialog(null)}
        />
      </TableCell>
    </TableRow>
  );
}

function BindRateCardDialog({
  user,
  rateCards,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOption>;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(
    user.rateCardId === null ? 'none' : String(user.rateCardId),
  );

  function onSubmit() {
    startTransition(async () => {
      const targetId = value === 'none' ? null : Number(value);
      const { bindRateCardAction } = await import('@/server/users-actions');
      const res = await bindRateCardAction(user.id, targetId);
      if (!notify(res, t('bindFailed'), t('rateCardUpdated'))) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button
                size="icon-sm"
                variant="ghost"
                title={t('bindRateCard')}
                aria-label={t('bindRateCard')}
              >
                <BanknoteIcon />
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('bindTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={value} onValueChange={(v) => setValue(v ?? '')}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('selectRateCard')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('unbind')}</SelectItem>
              {rateCards.map((r) => (
                <SelectItem key={r.id} value={String(r.id)}>
                  {r.name}（×{r.coefficient}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
