'use client';

import { Button, Input } from '@tokenlens/ui';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  abandonDeadBillingRequest,
  retryDeadBillingRequest,
} from '@/server/billing-operations-actions';

export function ReviewActions(props: { requestId: string; revision: number; status: 'dead' }) {
  const t = useTranslations('billingOperations');
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ error?: string }>, successMessage: string) => {
    if (!reason.trim()) {
      toast.error(t('reasonRequired'));
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
          placeholder={t('reasonPlaceholder')}
          maxLength={1000}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => retryDeadBillingRequest(base), t('retryQueued'))}
        >
          {t('retry')}
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
              t('abandoned'),
            )
          }
        >
          {t('abandon')}
        </Button>
      </div>
    );
  }
}
