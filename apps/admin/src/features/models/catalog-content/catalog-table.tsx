'use client';

// 货架表：表头（全选勾 + 列名）+ 当前页行渲染（行内草稿编辑在 catalog-row）+ 共享 Pager 分页

import { Checkbox, Table, TableBody, TableHead, TableHeader, TableRow } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import { Pager } from '@/components/pager';
import type { FxState } from './catalog-fx-bar';
import { type CatalogItem, type Draft } from './catalog-filter';
import { CatalogRow } from './catalog-row';

export function CatalogTable({
  paged,
  currency,
  fx,
  draftOf,
  onToggle,
  onPatch,
  onSelectAll,
  onOpenHistory,
  page,
  totalPages,
  total,
  onPageChange,
}: {
  paged: CatalogItem[];
  currency: 'USD' | 'CNY';
  fx: FxState | null;
  draftOf: (item: CatalogItem) => Draft;
  onToggle: (item: CatalogItem, selected: boolean) => void;
  onPatch: (item: CatalogItem, patchValue: Partial<Draft>) => void;
  onSelectAll: (selected: boolean) => void;
  onOpenHistory: (externalName: string) => void;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const t = useTranslations('modelMarket');
  const tc = useTranslations('common');
  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={paged.length > 0 && paged.every((i) => draftOf(i).selected)}
                  onCheckedChange={(v) => onSelectAll(v === true)}
                  title={t('selectAllTitle')}
                />
              </TableHead>
              <TableHead>{t('upstreamModel')}</TableHead>
              <TableHead className="w-40">{t('externalName')}</TableHead>
              <TableHead className="w-32 text-right">{t('catalogPrice', { currency })}</TableHead>
              <TableHead className="w-24 text-right">{t('inputPrice')}</TableHead>
              <TableHead className="w-24 text-right">{t('outputPrice')}</TableHead>
              <TableHead className="w-24 text-right">{t('cachePrice')}</TableHead>
              <TableHead className="w-24 text-right">{t('writePrice')}</TableHead>
              <TableHead className="w-24 text-right">{t('context')}</TableHead>
              <TableHead className="w-32">{tc('status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((item) => (
              <CatalogRow
                key={item.realModel}
                item={item}
                draft={draftOf(item)}
                fxEffectiveRate={fx?.effectiveRate ?? ''}
                onToggle={onToggle}
                onPatch={onPatch}
                onOpenHistory={onOpenHistory}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {/* 分页（共享 Pager 受控模式）：勾选跨页累计——导入按钮计数即全部已选 */}
      <Pager page={page} totalPages={totalPages} total={total} onPageChange={onPageChange} />
    </>
  );
}
