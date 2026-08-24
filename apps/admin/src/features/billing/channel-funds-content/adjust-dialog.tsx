'use client';

// 渠道余额调整弹窗（充值弹窗在 recharge-dialog，共享渠道下拉在 channel-select）

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
import { Loader2Icon, ScaleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { ChannelOption } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { ChannelSelect } from './channel-select';

export function AdjustDialog({ channels }: { channels: ReadonlyArray<ChannelOption> }) {
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
