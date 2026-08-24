'use client';

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
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
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
import { useRouter, useSearchParams } from 'next/navigation';
import { BanknoteIcon, ImageIcon, Loader2Icon, ScaleIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { fmtDateTime, formatMoney } from '@/lib/formatters';
import { signedAmountTone } from '@/lib/money-tone';

import type { AdminChannelFundRow, ChannelOption } from '@tokenlens/api-client';
import { useActionResult } from '@/components/action-toast';

function fmtSigned(v: string): string {
  const n = Number(v);
  return (n > 0 ? '+' : '') + formatMoney(v);
}

export function ChannelFundsClient({
  rows,
  channels,
  total,
  initialChannelId,
  initialType,
}: {
  readonly rows: ReadonlyArray<AdminChannelFundRow>;
  readonly channels: ReadonlyArray<ChannelOption>;
  readonly total: number;
  readonly initialChannelId?: number;
  readonly initialType?: 'recharge' | 'adjust';
}) {
  const t = useTranslations('channelFunds');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [channelFilter, setChannelFilter] = useState<string>(
    initialChannelId ? String(initialChannelId) : 'all',
  );
  const [typeFilter, setTypeFilter] = useState<string>(initialType ?? 'all');
  const router = useRouter();
  const currentParams = useSearchParams();

  function applyFilter(nextChannel: string, nextType: string) {
    setChannelFilter(nextChannel);
    setTypeFilter(nextType);
    // 保留 q/排序等其余筛选，只换 channel/type 并回到第 1 页
    const qs = new URLSearchParams(currentParams.toString());
    qs.delete('page');
    if (nextChannel !== 'all') qs.set('channelId', nextChannel);
    else qs.delete('channelId');
    if (nextType !== 'all') qs.set('type', nextType);
    else qs.delete('type');
    router.push(`/dashboard/channel-funds${qs.toString() ? `?${qs}` : ''}`);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={channelFilter} onValueChange={(v) => applyFilter(v ?? '', typeFilter)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder={t('allChannels')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('allChannels')}</SelectItem>
              {channels.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={(v) => applyFilter(channelFilter, v ?? '')}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={tc('allTypes')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tc('allTypes')}</SelectItem>
              <SelectItem value="recharge">{t('recharge')}</SelectItem>
              <SelectItem value="adjust">{t('adjust')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <RechargeDialog channels={channels} />
          <AdjustDialog channels={channels} />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t('totalLine', { count: total })}</p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">ID</TableHead>
            <TableHead className="w-40">{tc('time')}</TableHead>
            <TableHead>{t('channel')}</TableHead>
            <TableHead className="w-20">{tc('type')}</TableHead>
            <TableHead className="text-right">{t('amount')}</TableHead>
            <TableHead className="text-right">{t('balanceAfter')}</TableHead>
            <TableHead>{t('orderNo')}</TableHead>
            <TableHead>{t('voucher')}</TableHead>
            <TableHead>{t('operator')}</TableHead>
            <TableHead>{tc('remark')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                {t('noEntries')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  #{r.id}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {fmtDateTime(r.createdAt)}
                </TableCell>
                <TableCell className="font-medium">{r.channelName}</TableCell>
                <TableCell>
                  <span
                    className={
                      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ' +
                      (r.type === 'recharge'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')
                    }
                  >
                    {r.type === 'recharge' ? t('recharge') : t('adjust')}
                  </span>
                </TableCell>
                <TableCell
                  className={
                    'text-right font-medium tabular-nums ' + signedAmountTone(r.amount, locale)
                  }
                >
                  {fmtSigned(r.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(r.balanceAfter)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.orderNo ?? '—'}</TableCell>
                <TableCell>
                  {r.voucher ? (
                    <a href={`/v1/vouchers/${r.voucher}`} target="_blank" rel="noreferrer">
                      <ImageIcon className="size-4 text-muted-foreground hover:text-foreground" />
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.adminDisplayName ?? r.adminEmail ?? '—'}
                </TableCell>
                <TableCell className="max-w-xs text-xs text-muted-foreground">
                  {r.remark ?? '—'}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function ChannelSelect({
  value,
  onChange,
  channels,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  channels: ReadonlyArray<ChannelOption>;
  id: string;
}) {
  const t = useTranslations('channelFunds');
  return (
    <FormItem>
      <FieldLabel htmlFor={id}>{t('channel')}</FieldLabel>
      <Select value={value} onValueChange={(v) => onChange(v ?? '')}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={t('selectChannel')} />
        </SelectTrigger>
        <SelectContent>
          {channels.map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormItem>
  );
}

function RechargeDialog({ channels }: { channels: ReadonlyArray<ChannelOption> }) {
  const t = useTranslations('channelFunds');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [channelId, setChannelId] = useState('');
  const [amount, setAmount] = useState('');
  const [orderNo, setOrderNo] = useState('');
  const [remark, setRemark] = useState('');
  const [voucher, setVoucher] = useState<string | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error(t('voucherTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => setVoucher(reader.result as string));
    reader.readAsDataURL(file);
  }

  function reset() {
    setChannelId('');
    setAmount('');
    setOrderNo('');
    setRemark('');
    setVoucher(null);
  }

  function submit() {
    const amt = Number(amount);
    if (!channelId) return toast.error(t('channelRequired'));
    if (!Number.isFinite(amt) || amt <= 0) return toast.error(t('amountPositive'));
    startTransition(async () => {
      const { rechargeChannelAction } = await import('@/server/channel-funds-actions');
      const res = await rechargeChannelAction({
        channelId: Number(channelId),
        amount,
        orderNo,
        remark,
        voucherDataUrl: voucher ?? undefined,
      });
      if (!notify(res, t('rechargeFailed'), t('recharged'))) return;
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <BanknoteIcon /> {t('recharge')}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BanknoteIcon /> {t('rechargeTitle')}
          </DialogTitle>
          <DialogDescription>{t('rechargeDescription')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <ChannelSelect
            value={channelId}
            onChange={setChannelId}
            channels={channels}
            id="cf-channel"
          />
          <FormItem>
            <FieldLabel htmlFor="cf-amount">{t('amountLabel')}</FieldLabel>
            <Input
              id="cf-amount"
              type="number"
              step="0.01"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="cf-order">{t('orderNoLabel')}</FieldLabel>
            <Input
              id="cf-order"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              placeholder={t('orderNoPlaceholder')}
            />
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="cf-voucher">{t('voucherLabel')}</FieldLabel>
            <Input id="cf-voucher" type="file" accept="image/*" onChange={onFile} />
            {voucher ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={voucher}
                alt={t('voucherPreview')}
                className="mt-2 max-h-32 rounded border"
              />
            ) : null}
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="cf-remark">{t('remarkOptional')}</FieldLabel>
            <Input
              id="cf-remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder={t('remarkPlaceholder')}
            />
          </FormItem>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmRecharge')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ channels }: { channels: ReadonlyArray<ChannelOption> }) {
  const t = useTranslations('channelFunds');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [channelId, setChannelId] = useState('');
  const [amount, setAmount] = useState('');
  const [remark, setRemark] = useState('');

  function reset() {
    setChannelId('');
    setAmount('');
    setRemark('');
  }

  function submit() {
    const amt = Number(amount);
    if (!channelId) return toast.error(t('channelRequired'));
    if (!Number.isFinite(amt) || amt === 0) return toast.error(t('amountNonZero'));
    startTransition(async () => {
      const { adjustChannelAction } = await import('@/server/channel-funds-actions');
      const res = await adjustChannelAction({
        channelId: Number(channelId),
        amount,
        remark,
      });
      if (!notify(res, t('adjustFailed'), t('adjusted'))) return;
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline">
            <ScaleIcon /> {t('adjust')}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScaleIcon /> {t('adjustTitle')}
          </DialogTitle>
          <DialogDescription>{t('adjustDescription')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <ChannelSelect
            value={channelId}
            onChange={setChannelId}
            channels={channels}
            id="cf-adj-channel"
          />
          <FormItem>
            <FieldLabel htmlFor="cf-adj-amount">{t('amountSigned')}</FieldLabel>
            <Input
              id="cf-adj-amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={t('amountPlaceholder')}
            />
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="cf-adj-remark">{t('remarkOptional')}</FieldLabel>
            <Input
              id="cf-adj-remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder={t('reasonPlaceholder')}
            />
          </FormItem>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmAdjust')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
