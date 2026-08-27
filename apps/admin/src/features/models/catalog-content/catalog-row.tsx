'use client';

// 货架行项：勾选 + 模型标识 + 目录价展示 + 六格草稿编辑（对外名/输入/输出/缓存/回写/上下文）+ 状态徽章组与溯源入口

import { Badge, Checkbox, Input, TableCell, TableRow } from '@tillgate/ui';
import { HistoryIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DIFF_BADGE_CLASS, DIFF_BADGE_KEY, type CatalogItem, type Draft } from './catalog-filter';

// eslint-disable-next-line max-lines-per-function -- 一行十列草稿编辑格 + 徽章组是内聚行单元，再拆即「左半行/右半行」碎片
export function CatalogRow({
  item,
  draft,
  fxEffectiveRate,
  onToggle,
  onPatch,
  onOpenHistory,
}: {
  item: CatalogItem;
  draft: Draft;
  fxEffectiveRate: string;
  onToggle: (item: CatalogItem, selected: boolean) => void;
  onPatch: (item: CatalogItem, patchValue: Partial<Draft>) => void;
  onOpenHistory: (externalName: string) => void;
}) {
  const t = useTranslations('modelMarket');
  const { imported } = item;
  const badgeClass = DIFF_BADGE_CLASS[item.diff];
  const badgeKey = DIFF_BADGE_KEY[item.diff];
  return (
    <TableRow className={item.priceWarning ? 'bg-destructive/5' : undefined}>
      <TableCell>
        <Checkbox checked={draft.selected} onCheckedChange={(v) => onToggle(item, v === true)} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col">
          <code className="text-xs">{item.realModel}</code>
          <span className="text-xs text-muted-foreground">{item.displayName}</span>
        </div>
      </TableCell>
      <TableCell>
        <Input
          value={draft.externalName}
          onChange={(e) => onPatch(item, { externalName: e.target.value })}
          className="h-8 text-xs"
        />
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
        {item.currency === 'USD' ? '$' : '¥'}
        {Number(item.catalogPrompt)} / {Number(item.catalogCompletion)}
      </TableCell>
      <TableCell>
        <Input
          value={draft.inputPrice}
          onChange={(e) => onPatch(item, { inputPrice: e.target.value })}
          className="h-8 text-right text-xs tabular-nums"
          title={
            item.prefillInputCny != null
              ? t('prefillTitle', { rate: fxEffectiveRate })
              : t('noFxHint')
          }
        />
      </TableCell>
      <TableCell>
        <Input
          value={draft.outputPrice}
          onChange={(e) => onPatch(item, { outputPrice: e.target.value })}
          className="h-8 text-right text-xs tabular-nums"
        />
      </TableCell>
      <TableCell>
        <Input
          value={draft.cacheInputPrice}
          onChange={(e) => onPatch(item, { cacheInputPrice: e.target.value })}
          className="h-8 text-right text-xs tabular-nums"
        />
      </TableCell>
      <TableCell>
        <Input
          value={draft.cacheWritePrice}
          onChange={(e) => onPatch(item, { cacheWritePrice: e.target.value })}
          className="h-8 text-right text-xs tabular-nums"
          title={t('cacheWriteTitle')}
        />
      </TableCell>
      <TableCell>
        <Input
          value={draft.contextLength}
          placeholder="—"
          onChange={(e) => onPatch(item, { contextLength: e.target.value })}
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
            <Badge variant="outline">{t('importedAs', { name: item.imported.externalName })}</Badge>
          ) : null}
          {item.priceWarning ? (
            <Badge variant="destructive" className="gap-1">
              <TriangleAlertIcon className="size-3" />
              {t('upstreamCharges')}
            </Badge>
          ) : null}
          {imported ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title={t('historyButtonTitle')}
              onClick={() => onOpenHistory(imported.externalName)}
            >
              <HistoryIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
