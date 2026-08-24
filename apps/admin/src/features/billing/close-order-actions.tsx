'use client';

import { ConfirmDialog, DropdownMenuItem, RowActions } from '@tillgate/ui';
import { useState } from 'react';
import { Loader2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { closePaymentOrderAction } from '@/server/payment-orders-actions';

export function CloseOrderActions({ orderId }: { orderId: string }) {
  const t = useTranslations('paymentOrders');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const [pending, setPending] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function runClose() {
    setPending(true);
    const res = await closePaymentOrderAction(orderId);
    setPending(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(t('closedToast'));
  }

  return (
    <RowActions label={tc('actions')}>
      <DropdownMenuItem
        variant="destructive"
        disabled={pending}
        onClick={() => setConfirmOpen(true)}
      >
        {pending ? <Loader2Icon className="size-4 animate-spin" /> : <XIcon className="size-4" />}
        {t('close')}
      </DropdownMenuItem>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('close')}
        description={t('closeConfirm')}
        confirmLabel={tUi('confirm')}
        cancelLabel={tUi('cancel')}
        tone="destructive"
        onConfirm={runClose}
        onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
      />
    </RowActions>
  );
}
