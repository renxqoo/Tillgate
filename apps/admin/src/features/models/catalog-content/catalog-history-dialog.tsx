'use client';

// 价格溯源时间线（受控哑件）：某对外名的历次目录导入/改价——目录原价 × 汇率 → 预填 → 提交 全链

import { Badge, Button } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import { fmtDateTime } from '@/lib/formatters';
import type { PriceHistoryEntry } from '@/server/model-catalog-actions';

/** 单条溯源记录：动作徽章 + 时间/操作者 + 目录价/汇率/预填/提交四格快照 */
function HistoryEntryItem({ entry }: { entry: PriceHistoryEntry }) {
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

export function CatalogHistoryDialog({
  name,
  entries,
  pending,
  onClose,
}: {
  name: string;
  entries: PriceHistoryEntry[] | null;
  pending: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('modelMarket');
  const tc = useTranslations('common');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('historyTitle', { name })}</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {tc('close')}
          </Button>
        </div>
        {(() => {
          if (pending || entries == null) {
            return (
              <p className="py-6 text-center text-xs text-muted-foreground">{t('querying')}</p>
            );
          }
          if (entries.length === 0) {
            return (
              <p className="py-6 text-center text-xs text-muted-foreground">{t('noHistory')}</p>
            );
          }
          return (
            <ol className="flex flex-col gap-3">
              {entries.map((h, i) => (
                <HistoryEntryItem key={i} entry={h} />
              ))}
            </ol>
          );
        })()}
      </div>
    </div>
  );
}
