'use client';

// 绑定渠道弹窗（受控 open，由模型行操作打开；每次打开回显当前已绑定渠道）

import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useState, useTransition, type ReactElement } from 'react';

import { Loader2Icon, NetworkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';

export function BindChannelsDialog({
  model,
  channels,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
  trigger?: ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('models');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<number[]>(model.channelIds ?? []);

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function onSubmit() {
    startTransition(async () => {
      const { bindChannelsAction } = await import('@/server/models-actions');
      const res = await bindChannelsAction(model.id, selected);
      if (!notify(res, t('bindFailed'), t('channelsBound', { count: selected.length }))) return;
      setSelected([]);
      setInternalOpen(false);
      onOpenChange?.(false);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
    // 每次打开回显当前已绑定渠道（取消后再打开也重置为最新绑定）
    if (next) setSelected(model.channelIds ?? []);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={t('bindChannels')}>
                <NetworkIcon />
                {t('bindChannels')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> {t('bindTitle', { name: model.externalName })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('noChannels')}</p>
          ) : (
            channels.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border p-2 hover:bg-muted/50"
              >
                <Checkbox checked={selected.includes(c.id)} onCheckedChange={() => toggle(c.id)} />
                <div className="flex-1">
                  <p className="text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.providerName}</p>
                </div>
                <span className="text-xs text-muted-foreground">#{c.id}</span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmBind', { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
