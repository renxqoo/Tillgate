'use client';

// 模型级测试弹窗（受控 open，由模型行操作打开）

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useEffect, useState, useTransition, type ReactElement } from 'react';

import { FlaskConicalIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminModelRow } from '@tillgate/api-client';
import type { ModelTestResult } from '@/server/models-actions';

/** 模型级测试：逐绑定渠道真实最小生成（"1" + max_tokens 1，厘级成本） */
export function TestModelDialog({
  model,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  model: AdminModelRow;
  trigger?: ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('models');
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [results, setResults] = useState<ModelTestResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startTest() {
    setResults(null);
    setError(null);
    startTransition(async () => {
      const { testModelAction } = await import('@/server/models-actions');
      const res = await testModelAction(model.id);
      if (res.error) setError(res.error);
      else setResults(res.results ?? []);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
    if (next) {
      if (controlledOpen === undefined) startTest();
    } else {
      setResults(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (controlledOpen) startTest();
    // 受控菜单从关闭切到打开时执行一次真实测试；model.id 变化时也必须刷新结果。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledOpen, model.id]);

  let resultContent = null;
  if (pending) {
    resultContent = (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2Icon className="mr-2 animate-spin" /> {t('testing')}
      </div>
    );
  } else if (error) {
    resultContent = <p className="py-6 text-center text-sm text-destructive">{error}</p>;
  } else if (results?.length === 0) {
    resultContent = (
      <p className="py-6 text-center text-sm text-muted-foreground">{t('noBoundChannels')}</p>
    );
  } else if (results) {
    resultContent = (
      <ul className="flex flex-col gap-2">
        {results.map((r) => (
          <li
            key={r.channelId}
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
          >
            <span className="font-medium">{r.channel}</span>
            {r.ok ? (
              <span className="text-emerald-600">
                ✓ {r.durationMs}ms · {r.tokens ?? 0} tokens
              </span>
            ) : (
              <span className="max-w-56 truncate text-destructive" title={r.error?.message}>
                ✗ {r.error?.code ?? 'error'}
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={t('testTitle')}>
                <FlaskConicalIcon />
                {t('test')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent className="w-[32rem] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>{t('testDialogTitle', { name: model.externalName })}</DialogTitle>
          <DialogDescription>{t('testDescription')}</DialogDescription>
        </DialogHeader>
        {resultContent}
      </DialogContent>
    </Dialog>
  );
}
