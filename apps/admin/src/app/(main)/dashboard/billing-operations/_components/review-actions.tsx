'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@ai-gateway/ui/components/ui/button';
import { Input } from '@ai-gateway/ui/components/ui/input';
import { abandonDeadBillingRequest, retryDeadBillingRequest } from '../actions';

export function ReviewActions(props: {
  requestId: string;
  revision: number;
  status: 'dead';
}) {
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ error?: string }>, successMessage: string) => {
    if (!reason.trim()) {
      toast.error('必须填写复核理由');
      return;
    }
    startTransition(async () => {
      const result = await action();
      if (result.error) toast.error(result.error);
      else toast.success(successMessage);
    });
  };

  const base = { ...props, expectedRevision: props.revision, reason };

  if (props.status === 'dead') {
    return (
      <div className="flex min-w-96 gap-2">
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="重试 / 废弃原因（必填，进审计）"
          maxLength={1000}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => retryDeadBillingRequest(base), '已进入重试队列')}
        >
          重试
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() =>
            run(
              () =>
                abandonDeadBillingRequest({
                  requestId: props.requestId,
                  expectedRevision: props.revision,
                  reason,
                }),
              '已废弃并释放预扣',
            )
          }
        >
          废弃
        </Button>
      </div>
    );
  }

}
