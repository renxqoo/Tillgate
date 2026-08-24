'use client';

import { ConfirmDialog, DropdownMenuItem, DropdownMenuSeparator, RowActions } from '@tillgate/ui';
import { useState } from 'react';
import { Loader2Icon, Trash2Icon, ZapIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import {
  deleteChannelAction,
  testChannelAction,
  toggleChannelAction,
} from '@/server/notifications-actions';

export function ChannelActions({ id, status }: { id: number; status: number }) {
  const t = useTranslations('notifications');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const [pending, setPending] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function runDelete() {
    setPending('delete');
    const res = await deleteChannelAction(id);
    setPending(null);
    if (res.error) toast.error(res.error);
  }

  const onTest = async () => {
    setPending('test');
    const res = await testChannelAction(id);
    setPending(null);
    if (res.error) toast.error(res.error);
    else toast.success(t('testQueued'));
  };

  const onToggle = async () => {
    setPending('toggle');
    const res = await toggleChannelAction(id, status === 0 ? 1 : 0);
    setPending(null);
    if (res.error) toast.error(res.error);
  };

  return (
    <RowActions label={tc('actions')}>
      <DropdownMenuItem disabled={pending !== null} onClick={onTest}>
        {pending === 'test' ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <ZapIcon className="size-4" />
        )}
        {t('test')}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={pending !== null} onClick={onToggle}>
        {status === 0 ? t('disable') : t('enable')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={pending !== null}
        onClick={() => setConfirmOpen(true)}
      >
        {pending === 'delete' ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <Trash2Icon className="size-4" />
        )}
        {tc('delete')}
      </DropdownMenuItem>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tc('delete')}
        description={t('deleteConfirm')}
        confirmLabel={tc('delete')}
        cancelLabel={tUi('cancel')}
        tone="destructive"
        onConfirm={runDelete}
        onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
      />
    </RowActions>
  );
}
