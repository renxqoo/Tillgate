'use client';

// 目录动作条：搜索 × 价格/状态筛选 + 一键跟进 + 拉取元信息 + 密钥补录与导入按钮（值全受控，动作回调上抛编排器）

import { Input } from '@tillgate/ui';
import { useTranslations } from 'next-intl';

import { fmtDateTime } from '@/lib/formatters';
import { CatalogImportArea } from './catalog-import-area';
import type { PriceFilter, StateFilter } from './catalog-filter';
import { FilterButtonGroup } from './filter-button-group';
import { FollowDiffButtons } from './follow-diff-buttons';

export function CatalogToolbar({
  query,
  onQueryChange,
  priceFilter,
  onPriceFilterChange,
  stateFilter,
  onStateFilterChange,
  newCount,
  changedCount,
  followVisible,
  onApplyDiff,
  sourceName,
  fetchedAt,
  totalCount,
  needsKey,
  channelReady,
  apiKey,
  onApiKeyChange,
  pending,
  selectedCount,
  sourceKind,
  onImport,
}: {
  query: string;
  onQueryChange: (v: string) => void;
  priceFilter: PriceFilter;
  onPriceFilterChange: (f: PriceFilter) => void;
  stateFilter: StateFilter;
  onStateFilterChange: (f: StateFilter) => void;
  newCount: number;
  changedCount: number;
  followVisible: boolean;
  onApplyDiff: (kind: 'price_up' | 'price_down') => void;
  sourceName: string;
  fetchedAt: string;
  totalCount: number;
  needsKey: boolean;
  channelReady: boolean;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  pending: boolean;
  selectedCount: number;
  sourceKind: 'channel' | 'reference';
  onImport: () => void;
}) {
  const t = useTranslations('modelMarket');
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder={t('searchModels')}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="w-52"
      />
      <FilterButtonGroup
        options={[
          ['all', tUi('all')],
          ['free', tc('free')],
          ['paid', t('paid')],
        ]}
        active={priceFilter}
        onSelect={onPriceFilterChange}
      />
      <FilterButtonGroup
        options={[
          ['all', tUi('all')],
          ['new', t('filterNew', { count: newCount })],
          ['changed', t('filterChanged', { count: changedCount })],
          ['imported', t('importedLabel')],
        ]}
        active={stateFilter}
        onSelect={onStateFilterChange}
      />
      {followVisible ? <FollowDiffButtons onApplyDiff={onApplyDiff} /> : null}
      <span className="text-xs text-muted-foreground">
        {t('fetchedMeta', {
          source: sourceName,
          time: fmtDateTime(fetchedAt),
          count: totalCount,
        })}
      </span>
      <CatalogImportArea
        needsKey={needsKey}
        channelReady={channelReady}
        sourceName={sourceName}
        apiKey={apiKey}
        onApiKeyChange={onApiKeyChange}
        pending={pending}
        selectedCount={selectedCount}
        sourceKind={sourceKind}
        onImport={onImport}
      />
    </div>
  );
}
