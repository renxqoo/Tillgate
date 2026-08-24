'use client';

// 目录货架编排器：跨区块状态（筛选/分页/草稿/导入密钥/溯源弹窗）提升于此；
// 汇率条/动作条/货架表/消失清单/时间线在分域子组件（props 下传、回调上抛）

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useActionResult } from '@/components/action-toast';
import type { PriceHistoryEntry } from '@/server/model-catalog-actions';
import { CatalogFxBar, type FxState } from './catalog-fx-bar';
import { CatalogToolbar } from './catalog-toolbar';
import { CatalogTable } from './catalog-table';
import { CatalogGoneList } from './catalog-gone-list';
import { CatalogHistoryDialog } from './catalog-history-dialog';
import {
  filterItems,
  type CatalogItem,
  type Draft,
  type PriceFilter,
  type StateFilter,
} from './catalog-filter';

export type { CatalogItem } from './catalog-filter';
export type { FxState } from './catalog-fx-bar';

/**
 * 模型目录货架（多源）：勾选 → 预填价（USD 源 = 目录价 × 生效汇率，可改）→ 提交即确认。
 * 三态 diff 徽章（新增 / 上游涨价 / 上游降价）+ 亏钱警告 + 汇率条（覆盖/点差/强刷）+
 * 价格溯源时间线（目录价 × 汇率 → 预填 → 提交）。
 */
// eslint-disable-next-line max-lines-per-function -- 编排器：跨子组件状态（筛选/分页/草稿/导入/溯源）与导入流程的组装点，JSX 已全部下沉为分域子组件（存量棘轮，行为等价优先）
export function CatalogContent({
  sourceId,
  sourceName,
  sourceKind,
  currency,
  items,
  gone,
  fetchedAt,
  channelReady,
  needsKey,
  fx,
}: {
  sourceId: string;
  sourceName: string;
  sourceKind: 'channel' | 'reference';
  currency: 'USD' | 'CNY';
  items: CatalogItem[];
  gone: Array<{ mappingId: number; externalName: string; realModel: string }>;
  fetchedAt: string;
  channelReady: boolean;
  needsKey: boolean;
  fx: FxState | null;
}) {
  const t = useTranslations('modelMarket');
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [query, setQuery] = useState('');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  // 分页：大目录（models.dev 快照 6800+）整表渲染数万 DOM 节点直接卡死——
  // 每页 50 条；勾选草稿按 realModel 键存，跨页/筛选不丢
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);

  // 溯源时间线：打开的对外名 + 历次条目（拉取随 openHistory 触发，非 effect）
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<PriceHistoryEntry[] | null>(null);
  const [historyPending, startHistory] = useTransition();

  const changedCount = items.filter((i) => i.diff === 'price_up' || i.diff === 'price_down').length;
  const newCount = items.filter((i) => i.diff === 'new').length;

  const filtered = useMemo(
    () => filterItems(items, { query, priceFilter, stateFilter }),
    [items, query, priceFilter, stateFilter],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );
  // 筛选/搜索/切源后回第 1 页（结果集变了，旧页码无意义）——
  // 渲染期调整状态（React 官方「You Might Not Need an Effect」模式）替代 effect 内
  // setState，避免提交一帧旧页码 + effect 级联重渲染
  const filterKey = `${sourceId}\u0000${query}\u0000${priceFilter}\u0000${stateFilter}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  function draftOf(item: CatalogItem): Draft {
    return (
      drafts[item.realModel] ?? {
        selected: false,
        externalName: item.suggestedName,
        // 预填：USD 源 = 服务端换算值（× 生效汇率）；汇率不可用时回落 0（免费安全）
        inputPrice: item.prefillInputCny ?? '0',
        outputPrice: item.prefillOutputCny ?? '0',
        cacheInputPrice: '0',
        cacheWritePrice: '0',
        contextLength: item.contextLength != null ? String(item.contextLength) : '',
      }
    );
  }

  const selectedItems = filtered.filter((i) => draftOf(i).selected);

  function toggle(item: CatalogItem, selected: boolean): void {
    const d = draftOf(item);
    setDrafts((prev) => ({ ...prev, [item.realModel]: { ...d, selected } }));
  }

  function patch(item: CatalogItem, patchValue: Partial<Draft>): void {
    const d = draftOf(item);
    setDrafts((prev) => ({ ...prev, [item.realModel]: { ...d, ...patchValue } }));
  }

  function selectAll(selected: boolean): void {
    // 只作用于当前页（导入单批上限 200——跨页全选既危险也会被服务端拒绝；
    // 跨页累计用行勾选，导入按钮计数始终是全部已选）
    const next: Record<string, Draft> = { ...drafts };
    for (const i of paged) next[i.realModel] = { ...draftOf(i), selected };
    setDrafts(next);
  }

  function applyDiff(kind: 'price_up' | 'price_down'): void {
    // 一键跟进：把该方向漂移的行全选（预填已是换算新价，提交仍走确认）
    const next: Record<string, Draft> = { ...drafts };
    for (const i of items.filter((x) => x.diff === kind && x.prefillInputCny != null)) {
      next[i.realModel] = {
        ...draftOf(i),
        selected: true,
        inputPrice: i.prefillInputCny ?? '0',
        outputPrice: i.prefillOutputCny ?? '0',
      };
    }
    setDrafts(next);
    toast.info(kind === 'price_up' ? t('selectedPriceUp') : t('selectedPriceDown'));
  }

  function doImport(): void {
    if (selectedItems.length === 0) return;
    if (needsKey && !channelReady && apiKey.trim().length === 0) {
      toast.error(t('apiKeyRequired', { source: sourceName }));
      return;
    }
    startTransition(async () => {
      const { importCatalogAction } = await import('@/server/model-catalog-actions');
      const res = await importCatalogAction({
        sourceId,
        ...(needsKey && !channelReady ? { apiKey: apiKey.trim() } : {}),
        models: selectedItems.map((i) => {
          const d = draftOf(i);
          return {
            externalName: d.externalName,
            realModel: i.realModel,
            inputPrice: d.inputPrice || '0',
            outputPrice: d.outputPrice || '0',
            cacheInputPrice: d.cacheInputPrice || '0',
            cacheWritePrice: d.cacheWritePrice || '0',
            ...(d.contextLength.trim() !== '' && Number.isInteger(Number(d.contextLength))
              ? { contextLength: Number(d.contextLength) }
              : {}),
          };
        }),
      });
      if (
        notify(
          res,
          undefined,
          sourceKind === 'reference'
            ? t('importedDraft', { count: selectedItems.length })
            : t('imported', { count: selectedItems.length }),
        )
      ) {
        router.refresh();
      }
    });
  }

  function openHistory(externalName: string): void {
    setHistoryOf(externalName);
    setHistoryEntries(null);
    startHistory(async () => {
      const { priceHistoryAction } = await import('@/server/model-catalog-actions');
      const res = await priceHistoryAction(externalName);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setHistoryEntries(res.entries ?? []);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 汇率条（USD 源显示；追溯口径：请求账单快照基准汇率，点差只进预填） */}
      {currency === 'USD' && fx ? <CatalogFxBar fx={fx} /> : null}

      <CatalogToolbar
        query={query}
        onQueryChange={setQuery}
        priceFilter={priceFilter}
        onPriceFilterChange={setPriceFilter}
        stateFilter={stateFilter}
        onStateFilterChange={setStateFilter}
        newCount={newCount}
        changedCount={changedCount}
        followVisible={changedCount > 0 && sourceKind === 'channel'}
        onApplyDiff={applyDiff}
        sourceName={sourceName}
        fetchedAt={fetchedAt}
        totalCount={items.length}
        needsKey={needsKey}
        channelReady={channelReady}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        pending={pending}
        selectedCount={selectedItems.length}
        sourceKind={sourceKind}
        onImport={doImport}
      />

      <CatalogTable
        paged={paged}
        currency={currency}
        fx={fx}
        draftOf={draftOf}
        onToggle={toggle}
        onPatch={patch}
        onSelectAll={selectAll}
        onOpenHistory={openHistory}
        page={safePage}
        totalPages={totalPages}
        total={filtered.length}
        onPageChange={setPage}
      />

      {/* 上游消失（channel 源）：绑定到本源渠道但目录已无——复核下架 */}
      {sourceKind === 'channel' && gone.length > 0 ? <CatalogGoneList gone={gone} /> : null}

      {/* 价格溯源时间线 */}
      {historyOf != null ? (
        <CatalogHistoryDialog
          name={historyOf}
          entries={historyEntries}
          pending={historyPending}
          onClose={() => setHistoryOf(null)}
        />
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t('footerMain')}
        {sourceKind === 'reference' ? t('footerReference') : t('footerChannel')}
        {t('footerTest')}
      </p>
    </div>
  );
}
