'use client';

// 目录动作条：搜索 × 价格/状态筛选 + 一键跟进 + 拉取元信息 + 密钥补录与导入按钮（值全受控，动作回调上抛编排器）

import { Button, Input } from '@tillgate/ui';
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon, StoreIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { fmtDateTime } from '@/lib/formatters';
import type { PriceFilter, StateFilter } from './catalog-filter';

/** 筛选按钮组（价格/状态两组共用：options 为 [值, label] 平铺，激活项高亮） */
function FilterButtonGroup<K extends string>({
  options,
  active,
  onSelect,
}: {
  options: ReadonlyArray<readonly [K, string]>;
  active: K;
  onSelect: (k: K) => void;
}) {
  return (
    <div className="flex gap-1 text-xs">
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          onClick={() => onSelect(k)}
          className={`rounded-md px-2 py-1 ${active === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 一键跟进：把涨价/降价方向的漂移行全选（动作逻辑在编排器 applyDiff） */
function FollowDiffButtons({
  onApplyDiff,
}: {
  onApplyDiff: (kind: 'price_up' | 'price_down') => void;
}) {
  const t = useTranslations('modelMarket');
  return (
    <div className="flex gap-1">
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => onApplyDiff('price_up')}
      >
        <ArrowUpIcon className="mr-1 size-3" /> {t('followUp')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        onClick={() => onApplyDiff('price_down')}
      >
        <ArrowDownIcon className="mr-1 size-3" /> {t('followDown')}
      </Button>
    </div>
  );
}

/** 导入动作区：渠道未就绪时补录密钥 + 导入按钮（pending/选中计数受控，提交回调上抛） */
function CatalogImportArea({
  needsKey,
  channelReady,
  sourceName,
  apiKey,
  onApiKeyChange,
  pending,
  selectedCount,
  sourceKind,
  onImport,
}: {
  needsKey: boolean;
  channelReady: boolean;
  sourceName: string;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  pending: boolean;
  selectedCount: number;
  sourceKind: 'channel' | 'reference';
  onImport: () => void;
}) {
  const t = useTranslations('modelMarket');
  return (
    <div className="ml-auto flex items-center gap-2">
      {needsKey && !channelReady ? (
        <Input
          type="password"
          placeholder={t('apiKeyPlaceholder', { source: sourceName })}
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          className="w-72"
        />
      ) : null}
      <Button disabled={pending || selectedCount === 0} onClick={onImport}>
        {pending ? <Loader2Icon className="mr-1 animate-spin" /> : <StoreIcon className="mr-1" />}
        {sourceKind === 'reference'
          ? t('importDraftCount', { count: selectedCount })
          : t('importSelectedCount', { count: selectedCount })}
      </Button>
    </div>
  );
}

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
