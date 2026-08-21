'use client';

import { useState } from 'react';
import { Loader2Icon, XIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@ai-gateway/ui/components/ui/button';

import { closePaymentOrderAction } from '../actions';

export function CloseOrderActions({ orderId }: { orderId: string }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={async () => {
        if (!confirm('确认关闭该待支付订单？关闭后回调将无法入账。')) return;
        setPending(true);
        const res = await closePaymentOrderAction(orderId);
        setPending(false);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success('订单已关闭');
      }}
    >
      {pending ? <Loader2Icon className="size-4 animate-spin" /> : <XIcon className="size-4" />}
      关闭
    </Button>
  );
}
