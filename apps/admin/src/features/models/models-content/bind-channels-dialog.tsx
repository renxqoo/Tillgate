'use client';

// 绑定渠道弹窗（受控 open，由模型行操作打开；每次打开回显当前已绑定渠道与出站名）

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
  Input,
} from '@tillgate/ui';
import { useState, useTransition, type ReactElement } from 'react';

import { Loader2Icon, NetworkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { cn } from '@/lib/utils';

/** 绑定行本地态：渠道 id + 出站模型名（输入留空 = 服务端物化映射规范名） */
interface DraftBinding {
  channelId: number;
  upstreamModel: string;
}

/** model.channels → 弹窗草稿行（每次打开回显当前绑定） */
function draftsOf(model: AdminModelRow): DraftBinding[] {
  return (model.channels ?? []).map((c) => ({
    channelId: c.channelId,
    upstreamModel: c.upstreamModel,
  }));
}

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
  const [selected, setSelected] = useState<DraftBinding[]>(draftsOf(model));
  // 受控 open 由父级状态驱动，Radix 不为程序化开启回调 onOpenChange——
  // 打开态翻转时在渲染期同步回显（取当前 model.channels，revalidate 后即为新绑定）
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSelected(draftsOf(model));
  }

  function selectedOf(id: number): DraftBinding | undefined {
    return selected.find((s) => s.channelId === id);
  }

  function toggle(id: number) {
    setSelected((prev) =>
      prev.some((s) => s.channelId === id)
        ? prev.filter((s) => s.channelId !== id)
        : [...prev, { channelId: id, upstreamModel: '' }],
    );
  }

  function rename(id: number, upstreamModel: string) {
    setSelected((prev) => prev.map((s) => (s.channelId === id ? { ...s, upstreamModel } : s)));
  }

  function onSubmit() {
    startTransition(async () => {
      const { bindChannelsAction } = await import('@/server/models-actions');
      const res = await bindChannelsAction(
        model.id,
        selected.map((s) => ({
          channelId: s.channelId,
          // 留空不传——服务端物化为映射规范名（落库恒显式）
          ...(s.upstreamModel.trim() !== '' ? { upstreamModel: s.upstreamModel.trim() } : {}),
        })),
      );
      if (!notify(res, t('bindFailed'), t('channelsBound', { count: selected.length }))) return;
      setInternalOpen(false);
      onOpenChange?.(false);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
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
      <DialogContent className="w-[32rem] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> {t('bindTitle', { name: model.externalName })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(24rem,60vh)] space-y-2 overflow-y-auto">
          {channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('noChannels')}</p>
          ) : (
            channels.map((c) => {
              const draft = selectedOf(c.id);
              return (
                <div
                  key={c.id}
                  className={cn(
                    'rounded-md border p-2 transition-colors hover:bg-muted/50',
                    draft != null && 'border-primary/40 bg-primary/5 hover:bg-primary/5',
                  )}
                >
                  <label className="flex cursor-pointer items-center gap-3">
                    <Checkbox checked={draft != null} onCheckedChange={() => toggle(c.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={c.name}>
                        {c.name}
                      </span>
                      {c.providerName ? (
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={c.providerName}
                        >
                          {c.providerName}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">#{c.id}</span>
                  </label>
                  {draft != null ? (
                    <Input
                      className="mt-2 h-8 pl-7 text-xs"
                      placeholder={t('upstreamModelPlaceholder', { model: model.realModel })}
                      value={draft.upstreamModel}
                      onChange={(e) => rename(c.id, e.target.value)}
                    />
                  ) : null}
                </div>
              );
            })
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
