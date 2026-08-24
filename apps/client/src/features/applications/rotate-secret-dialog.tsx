'use client';

// 密钥轮换弹窗：受控/自持 open 双模，成功后一次性回显新 clientSecret（离开即不可再取）

import type * as React from 'react';
import { useState } from 'react';

import { Loader2Icon, RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  toast,
} from '@tillgate/ui';

import { actionResult } from '@/features/shared/action-result';
import { rotateSecretAction } from '@/server/actions/apps';

export function RotateSecretInline({
  id,
  name,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  id: number;
  name: string;
  trigger?: React.ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('apps');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [pending, setPending] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const onRotateSecret = async () => {
    setPending(true);
    const res = await rotateSecretAction(id);
    setPending(false);
    if (!actionResult(res, t('rotateFailed'))) return;
    // 成功契约：无 error 时 clientSecret（一次性明文）必在；缺字段视为契约破坏，跳过回显
    const { clientSecret } = res;
    if (clientSecret === undefined) return;
    setRevealed(clientSecret);
    toast.success(t('rotatedToast'));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setRevealed(null);
      }}
    >
      {trigger !== null ? (
        <DialogTrigger render={trigger ?? <Button variant="ghost" size="sm" />}>
          <RefreshCwIcon />
          {t('rotateSecret')}
        </DialogTrigger>
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('rotateTitle')}</DialogTitle>
          <DialogDescription>{t('rotateDesc', { name })}</DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="space-y-3 rounded-md bg-emerald-500/10 p-4 ring-1 ring-emerald-500/30">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
              {t('newSecretNotice')}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background/80 p-2 font-mono text-xs">
                {revealed}
              </code>
              <CopyButton value={revealed} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('rotateConfirmText')}</p>
        )}

        <DialogFooter>
          {revealed ? (
            <DialogClose render={<Button variant="outline" />}>{tCommon('done')}</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>{tUi('cancel')}</DialogClose>
              <Button disabled={pending} onClick={onRotateSecret}>
                {pending && <Loader2Icon className="animate-spin" />}
                {t('confirmRotate')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
