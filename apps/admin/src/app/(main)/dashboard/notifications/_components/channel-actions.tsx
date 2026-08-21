'use client';

import { useState } from 'react';
import { Loader2Icon, Trash2Icon, ZapIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@ai-gateway/ui/components/ui/button';

import { deleteChannelAction, testChannelAction, toggleChannelAction } from '../actions';

export function ChannelActions({ id, status }: { id: number; status: number }) {
  const t = useTranslations('notifications');
  const [pending, setPending] = useState<string | null>(null);
  return (
    <div className="flex gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={pending !== null}
        onClick={async () => {
          setPending('test');
          const res = await testChannelAction(id);
          setPending(null);
          if (res.error) toast.error(res.error);
          else toast.success(t('testQueued'));
        }}
      >
        {pending === 'test' ? <Loader2Icon className="size-4 animate-spin" /> : <ZapIcon className="size-4" />}
        {t('test')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending !== null}
        onClick={async () => {
          setPending('toggle');
          const res = await toggleChannelAction(id, status === 0 ? 1 : 0);
          setPending(null);
          if (res.error) toast.error(res.error);
        }}
      >
        {status === 0 ? t('disable') : t('enable')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending !== null}
        onClick={async () => {
          if (!confirm(t('deleteConfirm'))) return;
          setPending('delete');
          const res = await deleteChannelAction(id);
          setPending(null);
          if (res.error) toast.error(res.error);
        }}
      >
        {pending === 'delete' ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2Icon className="size-4" />}
      </Button>
    </div>
  );
}
