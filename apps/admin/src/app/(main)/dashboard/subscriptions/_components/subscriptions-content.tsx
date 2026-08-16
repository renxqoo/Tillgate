'use client';

import { useState, useTransition } from 'react';

import { ArrowUpRightIcon, Loader2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react';
import { toast } from 'sonner';

import { fmtDateTime, formatMoney, formatPoints } from '@ai-gateway/api-client/formatters';
import { Button } from '@ai-gateway/ui/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ai-gateway/ui/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@ai-gateway/ui/components/ui/field';
import { Input } from '@ai-gateway/ui/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ai-gateway/ui/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ai-gateway/ui/components/ui/table';

import type { PlanOption, AdminSubscriptionRow } from '@ai-gateway/api-client/types';
import { useActionResult } from "@ai-gateway/ui/components/action-toast";
import { defineStatusMeta, StatusPill } from "@ai-gateway/ui/components/status-pill";

const STATUS_META = defineStatusMeta({
  0: { label: '有效', tone: 'success' },
  1: { label: '到期', tone: 'warning' },
  2: { label: '取消', tone: 'neutral' },
});

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
function MoneyPoints({ value }: { value: string }) {
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{formatPoints(value)} 积分</span>
    </span>
  );
}

export function SubscriptionsTable({
  rows,
  plans,
}: {
  readonly rows: ReadonlyArray<AdminSubscriptionRow>;
  readonly plans: ReadonlyArray<PlanOption>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>用户</TableHead>
          <TableHead>套餐</TableHead>
          <TableHead className="w-16">席位</TableHead>
          <TableHead className="text-right">价格</TableHead>
          <TableHead>有效期</TableHead>
          <TableHead className="text-right">额度</TableHead>
          <TableHead className="text-right">已用</TableHead>
          <TableHead className="text-right">剩余</TableHead>
          <TableHead className="w-20">状态</TableHead>
          <TableHead className="w-40 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
              暂无订阅
            </TableCell>
          </TableRow>
        ) : (
          rows.map((r) => <SubscriptionRowItem key={r.id} row={r} plans={plans} />)
        )}
      </TableBody>
    </Table>
  );
}

function SubscriptionRowItem({
  row,
  plans,
}: {
  row: AdminSubscriptionRow;
  plans: ReadonlyArray<PlanOption>;
}) {
  const notify = useActionResult();
  const [pending, setPending] = useState<'renew' | 'cancel' | null>(null);
  const meta = STATUS_META.get(row.status);

  async function run(action: 'renew' | 'cancel') {
    setPending(action);
    const mod = await import('../actions');
    const res =
      action === 'renew'
        ? await mod.renewSubscriptionAction(row.id)
        : await mod.cancelSubscriptionAction(row.id);
    setPending(null);
    notify(res, action === 'renew' ? '续费失败' : '取消失败', action === 'renew' ? '已续费' : '已取消');
  }

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{row.userSubject}</div>
        {row.userDisplayName ? (
          <div className="text-xs text-muted-foreground">{row.userDisplayName}</div>
        ) : null}
      </TableCell>
      <TableCell className="font-medium">{row.planName}</TableCell>
      <TableCell className="tabular-nums">×{row.quantity}</TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.price} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <div>{fmtDateTime(row.startAt)}</div>
        <div className="text-muted-foreground/70">至 {fmtDateTime(row.endAt)}</div>
      </TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.quotaAmount} />
      </TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.usedAmount} />
      </TableCell>
      <TableCell className="text-right">
        <MoneyPoints value={row.remainingAmount} />
      </TableCell>
      <TableCell>
        <StatusPill tone={meta.tone} label={meta.label} />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {row.status === 0 ? (
            <>
              <ChangeSubscriptionDialog row={row} plans={plans} />
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => run('renew')}
              >
                {pending === 'renew' ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
                续费
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => {
                  if (!confirm('确定取消该订阅？剩余额度作废，不退款。')) return;
                  void run('cancel');
                }}
                className="text-destructive hover:text-destructive"
              >
                {pending === 'cancel' ? <Loader2Icon className="animate-spin" /> : <XCircleIcon />}
                取消
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 变更弹窗：升级到更高层级，或同套餐加席位（补差价由后端计算）。 */
function ChangeSubscriptionDialog({
  row,
  plans,
}: {
  row: AdminSubscriptionRow;
  plans: ReadonlyArray<PlanOption>;
}) {
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
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
      toast.error('请选择目标套餐');
      return;
    }
    if (!Number.isInteger(qty) || qty < row.quantity) {
      toast.error(`席位不能少于当前（${row.quantity}）`);
      return;
    }
    startTransition(async () => {
      const { changeSubscriptionAction } = await import('../actions');
      const res = await changeSubscriptionAction(row.id, { targetPlanId: target, quantity: qty });
      if (!notify(res, '变更失败', '已变更')) return;
      setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="变更（升级 / 扩容）">
          <ArrowUpRightIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpRightIcon /> 变更订阅 - {row.planName}
          </DialogTitle>
          <DialogDescription>
            升级到更高层级套餐或调整席位，系统按剩余额度与差价自动结算。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>目标套餐</FieldLabel>
            <Select value={targetPlanId} onValueChange={setTargetPlanId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.id === row.planId ? `${p.name}（加席位）` : p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="change-quantity">席位（当前 ×{row.quantity}）</FieldLabel>
            <Input
              id="change-quantity"
              type="number"
              min={row.quantity}
              step="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2Icon className="animate-spin" />}确认变更
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
