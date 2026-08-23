'use client';

import { Button } from '@tokenlens/ui';
import { useState } from 'react';
import { Loader2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { closePaymentOrderAction } from '@/server/payment-orders-actions';

export function CloseOrderActions({ orderId }: { orderId: string }) {
  const t = useTranslations('paymentOrders');
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={async () => {
        if (!confirm(t('closeConfirm'))) return;
        setPending(true);
        const res = await closePaymentOrderAction(orderId);
        setPending(false);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success(t('closedToast'));
      }}
    >
      {pending ? <Loader2Icon className="size-4 animate-spin" /> : <XIcon className="size-4" />}
      {t('close')}
    </Button>
  );
}
