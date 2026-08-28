'use client';

// 价格溯源时间线（受控哑件）：某对外名的历次目录导入/改价——目录原价 × 汇率 → 预填 → 提交 全链

import { Button } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import type { PriceHistoryEntry } from '@/server/model-catalog-actions';
import { HistoryEntryItem } from './history-entry-item';

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
