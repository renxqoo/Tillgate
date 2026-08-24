'use client';

// 变更订阅弹窗：升级到更高层级，或同套餐加席位（受控 open，由订阅行操作打开）

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldGroup,
  FieldLabel,
  FormItem,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@tillgate/ui';
import { useState, useTransition } from 'react';

import { ArrowUpRightIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import type { AdminSubscriptionRow } from '@tillgate/api-client';
import { useActionResult } from '@/components/action-toast';
import type { PlanOption } from './subscriptions-shared';

/** 变更弹窗：升级到更高层级，或同套餐加席位（补差价由后端计算）。 */
export function ChangeSubscriptionDialog({
  row,
  plans,
  open,
  onOpenChange,
}: {
  row: AdminSubscriptionRow;
  plans: ReadonlyArray<PlanOption>;
  /** 受控 open：由行操作菜单项打开 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('subscriptions');
  const tUi = useTranslations('ui');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();

  const currentPlan: PlanOption = plans.find((p) => p.id === row.planId) ?? {
    id: row.planId,
    name: row.planName,
    kind: 'subscription',
    sortOrder: null,
  };
  const currentSortOrder = currentPlan.sortOrder;
  const upgradePlans = plans
    .filter(
      (p) =>
        p.kind === 'subscription' &&
        p.id !== row.planId &&
        currentSortOrder !== null &&
        p.sortOrder !== null &&
        p.sortOrder >= currentSortOrder,
    )
    .toSorted((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const targets = [currentPlan, ...upgradePlans];

  const [targetPlanId, setTargetPlanId] = useState(String(row.planId));
  const [quantity, setQuantity] = useState(String(row.quantity));

  function reset() {
    setTargetPlanId(String(row.planId));
    setQuantity(String(row.quantity));
  }

  function submit() {
    const target = Number(targetPlanId);
    const qty = Number(quantity);
    if (!Number.isInteger(target) || target <= 0) {
      toast.error(t('targetRequired'));
      return;
    }
    if (!Number.isInteger(qty) || qty < row.quantity) {
      toast.error(t('quantityMin', { count: row.quantity }));
      return;
    }
    startTransition(async () => {
      const { changeSubscriptionAction } = await import('@/server/subscriptions-actions');
      const res = await changeSubscriptionAction(row.id, { targetPlanId: target, quantity: qty });
      if (!notify(res, t('changeFailed'), t('changed'))) return;
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpRightIcon /> {t('changeTitle', { name: row.planName })}
          </DialogTitle>
          <DialogDescription>{t('changeDescription')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <FormItem>
            <FieldLabel>{t('targetPlan')}</FieldLabel>
            <Select value={targetPlanId} onValueChange={(v) => setTargetPlanId(v ?? '')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.id === row.planId ? t('addSeats', { name: p.name }) : p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormItem>
          <FormItem>
            <FieldLabel htmlFor="change-quantity">
              {t('seatsLabel', { count: row.quantity })}
            </FieldLabel>
            <Input
              id="change-quantity"
              type="number"
              min={row.quantity}
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </FormItem>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">{tUi('cancel')}</Button>} />
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t('confirmChange')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
