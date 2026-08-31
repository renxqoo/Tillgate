'use client';

// 绑定渠道弹窗（受控 open，由模型行操作打开；每次打开回显当前已绑定渠道与出站名）。
// 绑定行卡（含「成本价覆盖」折叠编辑区）在 bind-channel-row.tsx——成本轴经 PricingEditor
// 与官方轴同构；'' = 继承映射官方价（契约层空串归一 null），提交恒显式携带五轴；
// 成本策略草稿（行模型）随弹窗保存，提交时经 buildPricingBillingConfig 收口为 costConfig
// （空策略不传 = 无策略，全量覆盖语义下清除旧值）。

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tillgate/ui';
import { useState, useTransition, type ReactElement } from 'react';

import { Loader2Icon, NetworkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { AdminModelRow, ChannelOption } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import { moneyText } from '@/lib/forms';
import type { PricingValue } from './billing-config-payload';
import {
  buildPricingBillingConfig,
  costConfigShape,
  emptyStrategyDraft,
  strategyDraftFromConfig,
} from './billing-config-payload';
import type { BindChannelItem } from '@/server/models-actions';
import {
  ChannelBindingRow,
  emptyCost,
  COST_PRICE_KEYS,
  type CostEditorOpen,
  type DraftBinding,
} from './bind-channel-row';

/** model.channels → 弹窗草稿行（每次打开回显当前绑定、已有成本覆盖与 costConfig 策略草稿，null → ''） */
function draftsOf(model: AdminModelRow): DraftBinding[] {
  const pricingUnit = model.pricingUnit ?? 'token';
  return (model.channels ?? []).map((c) => ({
    channelId: c.channelId,
    upstreamModel: c.upstreamModel,
    cost: {
      costInputPrice: c.costInputPrice ?? '',
      costOutputPrice: c.costOutputPrice ?? '',
      costCacheInputPrice: c.costCacheInputPrice ?? '',
      costCacheWritePrice: c.costCacheWritePrice ?? '',
      costUnitPrice: c.costUnitPrice ?? '',
    },
    strategy: strategyDraftFromConfig(pricingUnit, costConfigShape(c.costConfig)),
    costIsFree: c.costIsFree === true,
  }));
}

/** 绑定提交体：留空不传出站名（服务端物化规范名）；成本覆盖恒显式提交（'' = 继承，全量覆盖语义下不残留旧值）；
 * 成本策略经 buildPricingBillingConfig 收口（空策略不传 = 服务端落 {}，清除旧策略） */
function bindPayloadOf(selected: DraftBinding[], pricingUnit: string): BindChannelItem[] {
  return selected.map((s) => {
    const built = buildPricingBillingConfig(
      s.strategy ?? emptyStrategyDraft(pricingUnit),
      pricingUnit,
    );
    return {
      channelId: s.channelId,
      ...(s.upstreamModel.trim() !== '' ? { upstreamModel: s.upstreamModel.trim() } : {}),
      costInputPrice: s.cost.costInputPrice,
      costOutputPrice: s.cost.costOutputPrice,
      costCacheInputPrice: s.cost.costCacheInputPrice,
      costCacheWritePrice: s.cost.costCacheWritePrice,
      costUnitPrice: s.cost.costUnitPrice,
      ...(built.billingConfig != null ? { costConfig: built.billingConfig } : {}),
      costIsFree: s.costIsFree,
    };
  });
}

/** 成本覆盖校验：非空值须为非负数字文本（复用 moneyText 的金额形状——非法禁提交） */
function costPricesValid(selected: DraftBinding[]): boolean {
  const price = moneyText({ allowEmpty: true, message: 'invalid' });
  return selected.every((s) =>
    COST_PRICE_KEYS.every((key) => price.safeParse(s.cost[key]).success),
  );
}

/** PricingEditor 受控回写 → 草稿行：价格五轴 + 策略行模型草稿一并落草稿（跨折叠存活） */
function withCostValue(draft: DraftBinding, value: PricingValue): DraftBinding {
  return {
    ...draft,
    cost: {
      costInputPrice: value.inputPrice,
      costOutputPrice: value.outputPrice,
      costCacheInputPrice: value.cacheInputPrice,
      costCacheWritePrice: value.cacheWritePrice,
      costUnitPrice: value.unitPrice,
    },
    strategy: value.strategy,
  };
}

/** 策略草稿收口校验：任一行分时段/差价未填齐即回错误标记（与官方轴提交编排同口径） */
function buildErrorOf(
  selected: DraftBinding[],
  pricingUnit: string,
): 'windows' | 'tiers' | undefined {
  return selected
    .map(
      (s) =>
        buildPricingBillingConfig(s.strategy ?? emptyStrategyDraft(pricingUnit), pricingUnit).error,
    )
    .find((e) => e != null);
}

export function BindChannelsDialog({
  model,
  channels,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  model: AdminModelRow;
  channels: ReadonlyArray<ChannelOption>;
  trigger?: ReactElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('models');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<DraftBinding[]>(draftsOf(model));
  const [costEditorOpen, setCostEditorOpen] = useState<CostEditorOpen>({});
  // 受控 open 由父级状态驱动，Radix 不为程序化开启回调 onOpenChange——
  // 打开态翻转时在渲染期同步回显（取当前 model.channels，revalidate 后即为新绑定）
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSelected(draftsOf(model));
      setCostEditorOpen({});
    }
  }

  function selectedOf(id: number): DraftBinding | undefined {
    return selected.find((s) => s.channelId === id);
  }

  function toggle(id: number) {
    setSelected((prev) =>
      prev.some((s) => s.channelId === id)
        ? prev.filter((s) => s.channelId !== id)
        : [...prev, { channelId: id, upstreamModel: '', cost: emptyCost(), costIsFree: false }],
    );
  }

  function rename(id: number, upstreamModel: string) {
    setSelected((prev) => prev.map((s) => (s.channelId === id ? { ...s, upstreamModel } : s)));
  }

  /** PricingEditor 受控回写：价格五轴 + 策略草稿落草稿（withCostValue 纯函数承载形状） */
  function setCostValue(id: number, value: PricingValue) {
    setSelected((prev) => prev.map((s) => (s.channelId === id ? withCostValue(s, value) : s)));
  }

  function toggleCostEditor(id: number) {
    setCostEditorOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  /** 免费标记切换：价格草稿不动（业务判定走标记——用户裁决 2026-08-31） */
  function toggleFree(id: number, free: boolean) {
    setSelected((prev) => prev.map((s) => (s.channelId === id ? { ...s, costIsFree: free } : s)));
  }

  function onSubmit() {
    const pricingUnit = model.pricingUnit ?? 'token';
    if (!costPricesValid(selected)) {
      toast.error(t('costPriceInvalid'));
      return;
    }
    const buildError = buildErrorOf(selected, pricingUnit);
    if (buildError != null) {
      toast.error(buildError === 'windows' ? t('windowsFillError') : t('tiersFillError'));
      return;
    }
    startTransition(async () => {
      const { bindChannelsAction } = await import('@/server/models-actions');
      const res = await bindChannelsAction(model.id, bindPayloadOf(selected, pricingUnit));
      if (!notify(res, t('bindFailed'), t('channelsBound', { count: selected.length }))) return;
      setInternalOpen(false);
      onOpenChange?.(false);
    });
  }

  function handleOpenChange(next: boolean) {
    setInternalOpen(next);
    onOpenChange?.(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== null ? (
        <DialogTrigger
          render={
            trigger ?? (
              <Button size="sm" variant="ghost" title={t('bindChannels')}>
                <NetworkIcon />
                {t('bindChannels')}
              </Button>
            )
          }
        />
      ) : null}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon /> {t('bindTitle', { name: model.externalName })}
          </DialogTitle>
          <DialogDescription>{t('bindDescription')}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(32rem,65vh)] min-h-0 space-y-2 overflow-y-auto">
          {channels.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('noChannels')}</p>
          ) : (
            channels.map((c) => (
              <ChannelBindingRow
                key={c.id}
                channel={c}
                model={model}
                draft={selectedOf(c.id)}
                costOpen={costEditorOpen[c.id] === true}
                onToggle={toggle}
                onRename={rename}
                onCostValue={setCostValue}
                onToggleCost={toggleCostEditor}
                onToggleFree={toggleFree}
              />
            ))
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button disabled={pending} onClick={onSubmit}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmBind', { count: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
