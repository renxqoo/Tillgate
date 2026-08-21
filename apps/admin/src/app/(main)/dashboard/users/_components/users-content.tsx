'use client';

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

import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ai-gateway/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ai-gateway/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';
import { fmtDateTime, formatMoney } from '@ai-gateway/api-client/formatters';

import { AdjustDialog, GiftDialog, PasswordDialog } from './user-dialogs';
import type { RateCardOption, AdminUserRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { StatusPill } from "@ai-gateway/ui/components/status-pill";

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
          <TableHead className="w-16">ID</TableHead>
          <TableHead>{tc('account')}</TableHead>
          <TableHead>{tc('displayName')}</TableHead>
          <TableHead>{tc('email')}</TableHead>
          <TableHead className="w-20">{tc('status')}</TableHead>
          <TableHead className="w-20">{tc('type')}</TableHead>
          <TableHead>{t('rateCard')}</TableHead>
          <TableHead className="text-right">{t('settledBalance')}</TableHead>
          <TableHead className="text-right">{t('reservedBalance')}</TableHead>
          <TableHead className="text-right">{t('availableBalance')}</TableHead>
          <TableHead className="text-right">{tc('creditLimit')}</TableHead>
          <TableHead className="text-right">{tc('dailySpendLimit')}</TableHead>
          <TableHead className="w-44">{tc('lastLogin')}</TableHead>
          <TableHead className="w-40 text-right">{tc('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={14} className="h-24 text-center text-muted-foreground">
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

  async function toggleStatus() {
    const newStatus = user.status === 0 ? 1 : 0;
    const freezing = newStatus === 1;
    const freezeReason = freezing ? (prompt(t('freezeReasonPrompt')) ?? '') : '';
    if (freezing && !confirm(t('banConfirm', { subject: user.subject }))) return;
    setPending(true);
    const { setUserStatusAction } = await import('../actions');
    const res = await setUserStatusAction(user.id, {
      status: newStatus,
      freezeReason: freezing ? freezeReason : '',
    });
    setPending(false);
    notify(res, freezing ? t('banFailed') : t('unbanFailed'), freezing ? t('bannedShort') : t('unbanned'));
  }

  async function toggleEnterprise() {
    setPending(true);
    const { setUserEnterpriseAction } = await import('../actions');
    const res = await setUserEnterpriseAction(user.id, !user.isEnterprise);
    setPending(false);
    notify(res, tc('actionFailed'), user.isEnterprise ? t('removedEnterprise') : t('markedEnterprise'));
  }

  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        <Link href={`/dashboard/users/${user.id}`} className="hover:underline">
          #{user.id}
        </Link>
      </TableCell>
      <TableCell className="font-medium">
        <Link href={`/dashboard/users/${user.id}`} className="hover:underline">
          {user.subject}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">{user.displayName ?? '—'}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{user.email ?? '—'}</TableCell>
      <TableCell>
        {user.status === 0 ? (
          <StatusPill tone="success" label={tc('active')} />
        ) : (
          <StatusPill tone="danger" label={t('bannedShort')} title={user.freezeReason ?? undefined} />
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
      <TableCell className="text-right tabular-nums">
        {formatMoney(user.creditLimit)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {user.dailySpendLimit === null ? tc('unlimited') : formatMoney(user.dailySpendLimit)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {user.lastLoginAt ? fmtDateTime(user.lastLoginAt) : tc('never')}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <AdjustDialog
            user={user}
            trigger={
              <Button size="sm" variant="ghost" title={t('adjust')}>
                <ScaleIcon />
              </Button>
            }
          />
          <GiftDialog
            user={user}
            trigger={
              <Button size="sm" variant="ghost" title={t('gift')}>
                <GiftIcon />
              </Button>
            }
          />
          <PasswordDialog
            user={user}
            trigger={
              <Button size="sm" variant="ghost" title={t('setPassword')}>
                <KeyRoundIcon />
              </Button>
            }
          />
          <BindRateCardDialog user={user} rateCards={rateCards} />
          <Button
            size="sm"
            variant="ghost"
            title={user.isEnterprise ? t('removeEnterprise') : t('setEnterprise')}
            disabled={pending}
            onClick={toggleEnterprise}
          >
            {user.isEnterprise ? <UserIcon /> : <BriefcaseIcon />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title={tc('detail')}
            onClick={() => {
              window.location.href = `/dashboard/users/${user.id}`;
            }}
          >
            <EyeIcon />
          </Button>
          <Button
            size="sm"
            variant={user.status === 0 ? 'destructive' : 'outline'}
            disabled={pending}
            onClick={toggleStatus}
          >
            {pending ? (
              <Loader2Icon className="animate-spin" />
            ) : user.status === 0 ? (
              <ShieldOffIcon />
            ) : (
              <ShieldCheckIcon />
            )}
            {user.status === 0 ? t('ban') : t('unban')}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function BindRateCardDialog({
  user,
  rateCards,
}: {
  user: AdminUserRow;
  rateCards: ReadonlyArray<RateCardOption>;
}) {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<string>(
    user.rateCardId === null ? 'none' : String(user.rateCardId),
  );

  function onSubmit() {
    startTransition(async () => {
      const targetId = value === 'none' ? null : Number(value);
      const { bindRateCardAction } = await import('../actions');
      const res = await bindRateCardAction(user.id, targetId);
      if (!notify(res, t('bindFailed'), t('rateCardUpdated'))) return;
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title={t('bindRateCard')}>
          <BanknoteIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon /> {t('bindTitle', { subject: user.subject })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Select value={value} onValueChange={setValue}>
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
          <DialogClose asChild>
            <Button variant="outline">{tUi('cancel')}</Button>
          </DialogClose>
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
