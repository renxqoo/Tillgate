'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { retryDeadBillingRequest, confirmNoUpstreamCharge } from '../actions';

export function ReviewActions(props: {
  requestId: string;
  revision: number;
  status: 'dead' | 'uncertain';
}) {
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  const submit = () => {
    if (!reason.trim()) {
      toast.error('必须填写复核理由');
      return;
    }
    startTransition(async () => {
      const result =
        props.status === 'dead'
          ? await retryDeadBillingRequest({ ...props, expectedRevision: props.revision, reason })
          : await confirmNoUpstreamCharge({ ...props, expectedRevision: props.revision, reason });
      if (result.error) toast.error(result.error);
      else toast.success(props.status === 'dead' ? '已进入重试队列' : '已确认上游未收费并退回预扣');
    });
  };

  return (
    <div className="flex min-w-80 gap-2">
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={props.status === 'dead' ? '重试原因' : '无收费证据/工单号'}
        maxLength={1000}
      />
      <Button
        size="sm"
        variant={props.status === 'dead' ? 'outline' : 'destructive'}
        disabled={pending}
        onClick={submit}
      >
        {props.status === 'dead' ? '重试' : '确认退款'}
      </Button>
    </div>
  );
}
