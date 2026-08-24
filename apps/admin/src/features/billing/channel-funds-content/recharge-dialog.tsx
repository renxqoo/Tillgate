'use client';

// 渠道充值弹窗（调整弹窗在 adjust-dialog，共享渠道下拉在 channel-select）

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
} from '@tillgate/ui';
import { useState, useTransition } from 'react';
import { BanknoteIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { ChannelOption } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { ChannelSelect } from './channel-select';

export function RechargeDialog({ channels }: { channels: ReadonlyArray<ChannelOption> }) {
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
