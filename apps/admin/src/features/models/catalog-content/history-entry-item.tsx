'use client';

import { Badge } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import { fmtDateTime } from '@/lib/formatters';
import type { PriceHistoryEntry } from '@/server/model-catalog-actions';

/** 单条溯源记录：动作徽章 + 时间/操作者 + 目录价/汇率/预填/提交四格快照 */
export function HistoryEntryItem({ entry }: { entry: PriceHistoryEntry }) {
  const t = useTranslations('modelMarket');
  const h = entry;
  return (
    <li className="rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {h.action === 'model_catalog.import_draft' ? t('draftImport') : t('catalogImport')}
        </Badge>
        <span className="text-muted-foreground">{fmtDateTime(h.createdAt)}</span>
        {h.adminId != null ? (
          <span className="text-muted-foreground">{t('adminId', { id: h.adminId })}</span>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground md:grid-cols-4">
        <span>
          {t('catalogPrices', {
            prompt: h.catalogPrompt ?? '—',
            completion: h.catalogCompletion ?? '—',
          })}
        </span>
        <span>
          {t('fxLabel', {
            value: h.fx
              ? t('fxValue', { rate: h.fx.baseRate, source: h.fx.source ?? '—' }) +
                (h.fx.effectiveRate != null && h.fx.effectiveRate !== h.fx.baseRate
                  ? t('fxEffective', { rate: h.fx.effectiveRate })
                  : '')
              : '—',
          })}
        </span>
        <span>{t('prefill', { value: h.prefillInputCny ?? '—' })}</span>
        <span className="font-medium text-foreground">
          {t('submitted', {
            input: h.submittedInputCny,
            output: h.submittedOutputCny,
          })}
        </span>
      </div>
    </li>
  );
}
