'use client';

import {
  Badge,
  Button,
  Checkbox,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@tillgate/ui';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  StoreIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Pager } from '@/components/pager';
import { fmtDateTime } from '@/lib/formatters';
import { useActionResult } from '@/components/action-toast';
import {
  clearFxOverrideAction,
  importCatalogAction,
  priceHistoryAction,
  refreshFxAction,
  setFxBufferAction,
  setFxOverrideAction,
  type PriceHistoryEntry,
} from '@/server/model-catalog-actions';

/**
 * 模型目录货架（多源）：勾选 → 预填价（USD 源 = 目录价 × 生效汇率，可改）→ 提交即确认。
 * 三态 diff 徽章（新增 / 上游涨价 / 上游降价）+ 亏钱警告 + 汇率条（覆盖/点差/强刷）+
 * 价格溯源时间线（目录价 × 汇率 → 预填 → 提交）。
 */

export interface FxState {
  mode: 'auto' | 'override';
  baseRate: string | null;
  effectiveRate: string | null;
  bufferPct: string;
  source: string | null;
  fetchedAt: string | null;
}

export interface CatalogItem {
  realModel: string;
  displayName: string;
  contextLength: number | null;
  currency: 'USD' | 'CNY';
  catalogPrompt: string;
  catalogCompletion: string;
  suggestedName: string;
  imported: { externalName: string; inputPrice: string; outputPrice: string } | null;
  diff: 'new' | 'same' | 'price_up' | 'price_down';
  driftPct: number | null;
  isFree: boolean;
  priceWarning: boolean;
  prefillInputCny: string | null;
  prefillOutputCny: string | null;
}

interface Draft {
  selected: boolean;
  externalName: string;
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  cacheWritePrice: string;
  contextLength: string;
}

type PriceFilter = 'all' | 'free' | 'paid';
type StateFilter = 'all' | 'new' | 'changed' | 'imported';

// 徽章样式留模块级；label 是 modelMarket 命名空间的 i18n key，渲染处用 t 解析
const DIFF_BADGE_CLASS: Record<CatalogItem['diff'], string | null> = {
  new: 'bg-muted text-muted-foreground',
  same: null,
  price_up: 'bg-amber-500/15 text-amber-600',
  price_down: 'bg-emerald-500/15 text-emerald-600',
};

const DIFF_BADGE_KEY: Partial<Record<CatalogItem['diff'], string>> = {
  new: 'badgeNew',
  price_up: 'badgePriceUp',
  price_down: 'badgePriceDown',
};

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
  const tc = useTranslations('common');
  const tUi = useTranslations('ui');
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

  // 汇率条编辑态
  const [fxEditing, setFxEditing] = useState(false);
  const [overrideRate, setOverrideRate] = useState('');
  const [bufferPct, setBufferPct] = useState('');
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<PriceHistoryEntry[] | null>(null);
  const [historyPending, startHistory] = useTransition();

  const changedCount = items.filter((i) => i.diff === 'price_up' || i.diff === 'price_down').length;
  const newCount = items.filter((i) => i.diff === 'new').length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (
        q &&
        !i.realModel.toLowerCase().includes(q) &&
        !i.displayName.toLowerCase().includes(q) &&
        !i.suggestedName.toLowerCase().includes(q)
      )
        return false;
      if (priceFilter === 'free' && !i.isFree) return false;
      if (priceFilter === 'paid' && i.isFree) return false;
      if (stateFilter === 'new' && i.diff !== 'new') return false;
      if (stateFilter === 'changed' && i.diff !== 'price_up' && i.diff !== 'price_down')
        return false;
      if (stateFilter === 'imported' && i.imported == null) return false;
      return true;
    });
  }, [items, query, priceFilter, stateFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );
  // 筛选/搜索/切源后回第 1 页（结果集变了，旧页码无意义）
  useEffect(() => setPage(1), [query, priceFilter, stateFilter, sourceId]);

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
      )
        router.refresh();
    });
  }

  function saveFx(): void {
    startTransition(async () => {
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

  function openHistory(externalName: string): void {
    setHistoryOf(externalName);
    setHistoryEntries(null);
    startHistory(async () => {
      const res = await priceHistoryAction(externalName);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setHistoryEntries(res.entries ?? []);
    });
  }

  let fxSourceLabel = '';
  if (fx?.mode === 'override') fxSourceLabel = t('overrideSuffix');
  else if (fx?.source === 'ecb') fxSourceLabel = t('fxSourceEcb');
  else if (fx?.source) fxSourceLabel = t('fxSourceOther', { source: fx.source });

  return (
    <div className="flex flex-col gap-3">
      {/* 汇率条（USD 源显示；追溯口径：请求账单快照基准汇率，点差只进预填） */}
      {currency === 'USD' && fx ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium">
            {t('rate', { rate: fx.baseRate ?? t('unavailable') })}
            {fxSourceLabel}
          </span>
          {fx.bufferPct !== '0' ? (
            <Badge variant="outline">{t('buffer', { pct: fx.bufferPct })}</Badge>
          ) : null}
          {fx.effectiveRate != null ? (
            <span className="text-muted-foreground">
              {t('effective', { rate: fx.effectiveRate })}
            </span>
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
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => setFxEditing(false)}
                >
                  {tUi('cancel')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => setFxEditing(true)}
                >
                  {t('editFx')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await refreshFxAction(true);
                      if (res.error) toast.error(res.error);
                      else {
                        toast.success(t('refreshed'));
                        router.refresh();
                      }
                    })
                  }
                >
                  <RefreshCwIcon className="mr-1 size-3" /> {t('forceRefresh')}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={t('searchModels')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-52"
        />
        <div className="flex gap-1 text-xs">
          {(
            [
              ['all', tUi('all')],
              ['free', tc('free')],
              ['paid', t('paid')],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setPriceFilter(k)}
              className={`rounded-md px-2 py-1 ${priceFilter === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 text-xs">
          {(
            [
              ['all', tUi('all')],
              ['new', t('filterNew', { count: newCount })],
              ['changed', t('filterChanged', { count: changedCount })],
              ['imported', t('importedLabel')],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setStateFilter(k)}
              className={`rounded-md px-2 py-1 ${stateFilter === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {changedCount > 0 && sourceKind === 'channel' ? (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => applyDiff('price_up')}
            >
              <ArrowUpIcon className="mr-1 size-3" /> {t('followUp')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => applyDiff('price_down')}
            >
              <ArrowDownIcon className="mr-1 size-3" /> {t('followDown')}
            </Button>
          </div>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {t('fetchedMeta', {
            source: sourceName,
            time: fmtDateTime(fetchedAt),
            count: items.length,
          })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {needsKey && !channelReady ? (
            <Input
              type="password"
              placeholder={t('apiKeyPlaceholder', { source: sourceName })}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-72"
            />
          ) : null}
          <Button disabled={pending || selectedItems.length === 0} onClick={doImport}>
            {pending ? (
              <Loader2Icon className="mr-1 animate-spin" />
            ) : (
              <StoreIcon className="mr-1" />
            )}
            {sourceKind === 'reference'
              ? t('importDraftCount', { count: selectedItems.length })
              : t('importSelectedCount', { count: selectedItems.length })}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={paged.length > 0 && paged.every((i) => draftOf(i).selected)}
                  onCheckedChange={(v) => selectAll(v === true)}
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
            {paged.map((item) => {
              const d = draftOf(item);
              const badgeClass = DIFF_BADGE_CLASS[item.diff];
              const badgeKey = DIFF_BADGE_KEY[item.diff];
              return (
                <TableRow
                  key={item.realModel}
                  className={item.priceWarning ? 'bg-destructive/5' : undefined}
                >
                  <TableCell>
                    <Checkbox
                      checked={d.selected}
                      onCheckedChange={(v) => toggle(item, v === true)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <code className="text-xs">{item.realModel}</code>
                      <span className="text-xs text-muted-foreground">{item.displayName}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.externalName}
                      onChange={(e) => patch(item, { externalName: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                    {item.currency === 'USD' ? '$' : '¥'}
                    {Number(item.catalogPrompt)} / {Number(item.catalogCompletion)}
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.inputPrice}
                      onChange={(e) => patch(item, { inputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title={
                        item.prefillInputCny != null
                          ? t('prefillTitle', { rate: fx?.effectiveRate ?? '' })
                          : t('noFxHint')
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.outputPrice}
                      onChange={(e) => patch(item, { outputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.cacheInputPrice}
                      onChange={(e) => patch(item, { cacheInputPrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.cacheWritePrice}
                      onChange={(e) => patch(item, { cacheWritePrice: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title={t('cacheWriteTitle')}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={d.contextLength}
                      placeholder="—"
                      onChange={(e) => patch(item, { contextLength: e.target.value })}
                      className="h-8 text-right text-xs tabular-nums"
                      title={t('contextTitle')}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {badgeClass && badgeKey ? (
                        <Badge variant="outline" className={badgeClass}>
                          {t(badgeKey)}
                          {item.driftPct != null && item.driftPct !== 0
                            ? ` ${item.driftPct > 0 ? '+' : ''}${item.driftPct}%`
                            : ''}
                        </Badge>
                      ) : null}
                      {item.imported ? (
                        <Badge variant="outline">
                          {t('importedAs', { name: item.imported.externalName })}
                        </Badge>
                      ) : null}
                      {item.priceWarning ? (
                        <Badge variant="destructive" className="gap-1">
                          <TriangleAlertIcon className="size-3" />
                          {t('upstreamCharges')}
                        </Badge>
                      ) : null}
                      {item.imported ? (
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          title={t('historyButtonTitle')}
                          onClick={() => openHistory(item.imported!.externalName)}
                        >
                          <HistoryIcon className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* 分页（共享 Pager 受控模式）：勾选跨页累计——导入按钮计数即全部已选 */}
      <Pager
        page={safePage}
        totalPages={totalPages}
        total={filtered.length}
        onPageChange={setPage}
      />

      {/* 上游消失（channel 源）：绑定到本源渠道但目录已无——复核下架 */}
      {sourceKind === 'channel' && gone.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          <span className="font-medium text-amber-600">
            {t('goneTitle', { count: gone.length })}
          </span>
          <span className="ml-2 text-muted-foreground">
            {gone.length > 8
              ? `${t('goneListMore', {
                  list: gone
                    .slice(0, 8)
                    .map((g) => g.externalName)
                    .join(', '),
                  count: gone.length,
                })}${t('goneSuffix')}`
              : `${gone
                  .slice(0, 8)
                  .map((g) => g.externalName)
                  .join(', ')}${t('goneSuffix')}`}
          </span>
        </div>
      ) : null}

      {/* 价格溯源时间线 */}
      {historyOf != null ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setHistoryOf(null)}
        >
          <div
            className="max-h-[70vh] w-full max-w-2xl overflow-auto rounded-lg border bg-background p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('historyTitle', { name: historyOf })}</h3>
              <Button size="sm" variant="ghost" onClick={() => setHistoryOf(null)}>
                {tc('close')}
              </Button>
            </div>
            {(() => {
              if (historyPending || historyEntries == null)
                return (
                  <p className="py-6 text-center text-xs text-muted-foreground">{t('querying')}</p>
                );
              if (historyEntries.length === 0)
                return (
                  <p className="py-6 text-center text-xs text-muted-foreground">{t('noHistory')}</p>
                );
              return (
                <ol className="flex flex-col gap-3">
                  {historyEntries.map((h, i) => (
                    <li key={i} className="rounded-md border p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {h.action === 'model_catalog.import_draft'
                            ? t('draftImport')
                            : t('catalogImport')}
                        </Badge>
                        <span className="text-muted-foreground">{fmtDateTime(h.createdAt)}</span>
                        {h.adminId != null ? (
                          <span className="text-muted-foreground">
                            {t('adminId', { id: h.adminId })}
                          </span>
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
                  ))}
                </ol>
              );
            })()}
          </div>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t('footerMain')}
        {sourceKind === 'reference' ? t('footerReference') : t('footerChannel')}
        {t('footerTest')}
      </p>
    </div>
  );
}
