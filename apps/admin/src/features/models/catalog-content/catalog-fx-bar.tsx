'use client';

// 汇率条（USD 源）：基准/点差/生效汇率展示 + 覆盖与点差编辑 + 强刷（编辑态自持于此，随状态走 server action 与 toast）

import { Badge, Button, Input } from '@tillgate/ui';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { fmtDateTime } from '@/lib/formatters';

export interface FxState {
  mode: 'auto' | 'override';
  baseRate: string | null;
  effectiveRate: string | null;
  bufferPct: string;
  source: string | null;
  fetchedAt: string | null;
}

// eslint-disable-next-line max-lines-per-function -- 汇率条：基准展示/覆盖与点差编辑/强刷三段内联平铺 + 保存流程三步串联，再拆即无语义碎片（存量棘轮，行为等价优先）
export function CatalogFxBar({ fx }: { fx: FxState }) {
  const t = useTranslations('modelMarket');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // 汇率条编辑态
  const [fxEditing, setFxEditing] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [bufferPct, setBufferPct] = useState('');

  function saveFx(): void {
    startTransition(async () => {
      const { setFxOverrideAction, clearFxOverrideAction, setFxBufferAction } =
        await import('@/server/model-catalog-actions');
      if (overrideRate.trim()) {
        const res = await setFxOverrideAction(overrideRate.trim());
        if (res.error) {
          toast.error(res.error);
          return;
        }
      } else {
        const res = await clearFxOverrideAction();
        if (res.error) {
          toast.error(res.error);
          return;
        }
      }
      if (bufferPct.trim()) {
        const res = await setFxBufferAction(bufferPct.trim());
        if (res.error) {
          toast.error(res.error);
          return;
        }
      }
      setFxEditing(false);
      setOverrideRate('');
      setBufferPct('');
      toast.success(t('fxSaved'));
      router.refresh();
    });
  }

  function forceRefreshFx(): void {
    startTransition(async () => {
      const { refreshFxAction } = await import('@/server/model-catalog-actions');
      const res = await refreshFxAction(true);
      if (res.error) toast.error(res.error);
      else {
        toast.success(t('refreshed'));
        router.refresh();
      }
    });
  }

  let fxSourceLabel = '';
  if (fx?.mode === 'override') fxSourceLabel = t('overrideSuffix');
  else if (fx?.source === 'ecb') fxSourceLabel = t('fxSourceEcb');
  else if (fx?.source) fxSourceLabel = t('fxSourceOther', { source: fx.source });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <span className="font-medium">
        {t('rate', { rate: fx.baseRate ?? t('unavailable') })}
        {fxSourceLabel}
      </span>
      {fx.bufferPct !== '0' ? (
        <Badge variant="outline">{t('buffer', { pct: fx.bufferPct })}</Badge>
      ) : null}
      {fx.effectiveRate != null ? (
        <span className="text-muted-foreground">{t('effective', { rate: fx.effectiveRate })}</span>
      ) : null}
      {fx.fetchedAt ? (
        <span className="text-muted-foreground">· {fmtDateTime(fx.fetchedAt)}</span>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {fxEditing ? (
          <>
            <Input
              placeholder={t('overridePlaceholder', { rate: fx.baseRate ?? '—' })}
              value={overrideRate}
              onChange={(e) => setOverrideRate(e.target.value)}
              className="h-7 w-56 text-xs"
            />
            <Input
              placeholder={t('bufferPlaceholder', { pct: fx.bufferPct })}
              value={bufferPct}
              onChange={(e) => setBufferPct(e.target.value)}
              className="h-7 w-36 text-xs"
            />
            <Button size="sm" className="h-7" disabled={pending} onClick={saveFx}>
              {tc('save')}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setFxEditing(false)}>
              {tUi('cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" className="h-7" onClick={() => setFxEditing(true)}>
              {t('editFx')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={pending}
              onClick={forceRefreshFx}
            >
              <RefreshCwIcon className="mr-1 size-3" /> {t('forceRefresh')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
