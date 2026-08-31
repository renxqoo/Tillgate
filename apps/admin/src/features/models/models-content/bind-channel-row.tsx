'use client';

// 绑定渠道弹窗的单个绑定行卡：渠道勾选 + 出站名输入 + 成本价覆盖编辑区。
// 成本轴经 PricingEditor 与官方轴完全同构（单位感知分派 + 分时段/差价 + 继承回显，
// 双轨定价 docs/channel-cost-pricing.md）：五轴 string 草稿沿用（'' = 继承映射官方价，
// 契约层空串归一 null），策略行模型草稿（PricingStrategyDraft）由弹窗保存以跨折叠存活，
// 提交时经 buildPricingBillingConfig 收口为 costConfig。独立成文件因 oxlint
// no-multi-component / max-lines-per-function 门禁：弹窗与行卡各一组件。

import { Checkbox, Input } from '@tillgate/ui';

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { cn } from '@/lib/utils';
import {
  strategyHasOverride,
  type PricingStrategyDraft,
  type PricingValue,
} from './billing-config-payload';
import { PricingEditor } from './pricing-editor';

/** 绑定行成本覆盖五轴（表单态 string，'' = 继承；与 messages.models cost* label 键一致） */
export const COST_PRICE_KEYS = [
  'costInputPrice',
  'costOutputPrice',
  'costCacheInputPrice',
  'costCacheWritePrice',
  'costUnitPrice',
] as const;

export type CostPriceKey = (typeof COST_PRICE_KEYS)[number];

/** 成本覆盖行展开态：弹窗行紧凑，编辑区默认折叠（PricingEditor 展开后全宽渲染） */
export type CostEditorOpen = Record<number, boolean>;

/** 绑定行本地态：出站名 + 成本五轴 + 策略草稿 + 免费标记（勾选免费不清价格——业务判定走标记） */
export interface DraftBinding {
  channelId: number;
  upstreamModel: string;
  cost: Record<CostPriceKey, string>;
  /** 成本策略草稿（schedule/variant 行模型，编辑无损态）；undefined = 未配置（继承官方定价策略） */
  strategy?: PricingStrategyDraft;
  /** 成本免费显式标记：true = 进货成本恒 0（价格列保持继承默认） */
}

/** 空白成本五轴（新勾选行起点：全部继承官方价） */
export function emptyCost(): Record<CostPriceKey, string> {
  return {
    costInputPrice: '',
    costOutputPrice: '',
    costCacheInputPrice: '',
    costCacheWritePrice: '',
    costUnitPrice: '',
  };
}

/** 绑定行官方平价参照（成本轴继承占位 = 官方价对应轴的实际生效值） */
export function officialReferenceOf(model: AdminModelRow): PricingValue {
  return {
    pricingUnit: model.pricingUnit ?? 'token',
    inputPrice: model.inputPrice ?? '',
    outputPrice: model.outputPrice ?? '',
    cacheInputPrice: model.cacheInputPrice ?? '',
    cacheWritePrice: model.cacheWritePrice ?? '',
    unitPrice: model.unitPrice ?? '',
  };
}

/** 草稿 → PricingEditor 受控值（计价方式恒随模型行：单位锁定） */
function costValueOf(model: AdminModelRow, draft: DraftBinding): PricingValue {
  return {
    pricingUnit: model.pricingUnit ?? 'token',
    inputPrice: draft.cost.costInputPrice,
    outputPrice: draft.cost.costOutputPrice,
    cacheInputPrice: draft.cost.costCacheInputPrice,
    cacheWritePrice: draft.cost.costCacheWritePrice,
    unitPrice: draft.cost.costUnitPrice,
    strategy: draft.strategy,
  };
}

/** 全五轴空且无策略 = 该渠道无价格覆盖（折叠摘要「继承官方价」；免费标记独立判定） */
/** 免费渠道 = 成本五轴显式全 0（价格推导，无平行标记——docs/free-by-price.md） */
function costAllZero(draft: DraftBinding): boolean {
  return COST_PRICE_KEYS.every((key) => draft.cost[key] === '0');
}

function allInherit(draft: DraftBinding): boolean {
  return (
    COST_PRICE_KEYS.every((key) => draft.cost[key] === '') && !strategyHasOverride(draft.strategy)
  );
}

/** 单个绑定行卡：渠道勾选 + 出站名输入 + 成本价覆盖折叠编辑区 */
export function ChannelBindingRow({
  channel,
  model,
  draft,
  costOpen,
  onToggle,
  onRename,
  onCostValue,
  onToggleCost,
  onToggleFree,
}: {
  channel: ChannelOption;
  model: AdminModelRow;
  draft: DraftBinding | undefined;
  costOpen: boolean;
  onToggle: (id: number) => void;
  onRename: (id: number, upstreamModel: string) => void;
  onCostValue: (id: number, value: PricingValue) => void;
  onToggleCost: (id: number) => void;
  /** 免费标记切换（价格草稿不动——业务判定走标记） */
  onToggleFree: (id: number, free: boolean) => void;
}) {
  const t = useTranslations('models');
  return (
    <div
      className={cn(
        'rounded-md border p-2 transition-colors hover:bg-muted/50',
        draft != null && 'border-primary/40 bg-primary/5 hover:bg-primary/5',
      )}
    >
      <label className="flex cursor-pointer items-center gap-3">
        <Checkbox checked={draft != null} onCheckedChange={() => onToggle(channel.id)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={channel.name}>
            {channel.name}
          </span>
          {channel.providerName ? (
            <span
              className="block truncate text-xs text-muted-foreground"
              title={channel.providerName}
            >
              {channel.providerName}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">#{channel.id}</span>
      </label>
      {draft != null ? (
        <div className="mt-2 space-y-2 pl-7">
          <Input
            className="h-8 text-xs"
            placeholder={t('upstreamModelPlaceholder', { model: model.realModel })}
            value={draft.upstreamModel}
            onChange={(e) => onRename(channel.id, e.target.value)}
          />
          <button
            type="button"
            onClick={() => onToggleCost(channel.id)}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {costOpen ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            {t('costOverride')}
            {costAllZero(draft) ? (
              <span className="text-muted-foreground">· {t('costFreeLabel')}</span>
            ) : allInherit(draft) ? (
              <span className="text-muted-foreground">· {t('costInherit')}</span>
            ) : null}
          </button>
          {costOpen ? (
            <PricingEditor
              axes="cost"
              unitLocked
              allowEmpty
              value={costValueOf(model, draft)}
              referenceValue={officialReferenceOf(model)}
              free={costAllZero(draft)}
              onFreeChange={(free) => onToggleFree(channel.id, free)}
              onChange={(next) => onCostValue(channel.id, next)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
