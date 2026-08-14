"use client";

import { useTransition } from "react";

import { GemIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { fmtDateTime, formatMoney, formatPoints } from "@ai-gateway/api-client/formatters";
import { Button } from "@ai-gateway/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ai-gateway/ui/components/ui/card";
import { Progress } from "@ai-gateway/ui/components/ui/progress";

import type { CurrentSubscription, PlanRow } from "../types";

/** 周期天数展示：30→月付，365→年付，其余按天。 */
function fmtPeriod(days: number): string {
  if (days === 30) return "月付";
  if (days === 365) return "年付";
  return `${days} 天`;
}

/** 钱 + 积分并列展示（纯展示层，积分 = 元 × 100）。 */
function MoneyPoints({ value }: { value: string }) {
  return (
    <span className="tabular-nums">
      <span className="font-medium">¥{formatMoney(value)}</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{formatPoints(value)} 积分</span>
    </span>
  );
}

/** 已用占比（0-100），仅用于进度条展示。 */
function usagePercent(used: string, quota: string): number {
  const u = Number(used);
  const q = Number(quota);
  if (!Number.isFinite(u) || !Number.isFinite(q) || q <= 0) return 0;
  return Math.min(100, Math.max(0, (u / q) * 100));
}

export function SubscriptionContent({
  subscription,
  plans,
  subError,
  plansError,
}: {
  readonly subscription: CurrentSubscription | null;
  readonly plans: ReadonlyArray<PlanRow>;
  readonly subError: string | null;
  readonly plansError: string | null;
}) {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前订阅</CardTitle>
          <CardDescription>套餐生效期与额度使用情况</CardDescription>
        </CardHeader>
        <CardContent>
          {subError ? (
            <p className="text-sm text-destructive">{subError}</p>
          ) : subscription ? (
            <CurrentSubscriptionCard sub={subscription} />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <GemIcon className="size-4" />
              未订阅，请在下方选择一个套餐购买
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">可购套餐</CardTitle>
          <CardDescription>用余额购买，购买后立即生效</CardDescription>
        </CardHeader>
        <CardContent>
          {plansError ? (
            <p className="text-sm text-destructive">{plansError}</p>
          ) : plans.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无可购套餐</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((p) => (
                <PlanCard key={p.id} plan={p} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CurrentSubscriptionCard({ sub }: { sub: CurrentSubscription }) {
  const pct = usagePercent(sub.usedAmount, sub.quotaAmount);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">{sub.planName}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {fmtDateTime(sub.startAt)} 至 {fmtDateTime(sub.endAt)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">额度</div>
          <div className="mt-1">
            <MoneyPoints value={sub.quotaAmount} />
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">已用</div>
          <div className="mt-1">
            <MoneyPoints value={sub.usedAmount} />
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">剩余</div>
          <div className="mt-1">
            <MoneyPoints value={sub.remainingAmount} />
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Progress value={pct} />
        <p className="text-xs text-muted-foreground">已使用 {pct.toFixed(1)}%</p>
      </div>
    </div>
  );
}

function PlanCard({ plan }: { plan: PlanRow }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{plan.name}</span>
        <span className="text-xs text-muted-foreground">{fmtPeriod(plan.periodDays)}</span>
      </div>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">价格</span>
          <MoneyPoints value={plan.price} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">额度</span>
          <MoneyPoints value={plan.quotaAmount} />
        </div>
      </div>
      <Button
        className="mt-auto"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            const { purchaseSubscriptionAction } = await import("../actions");
            const res = await purchaseSubscriptionAction(plan.id);
            if (res.error) {
              toast.error("购买失败", { description: res.error });
              return;
            }
            toast.success("购买成功");
          });
        }}
      >
        {pending && <Loader2Icon className="animate-spin" />}
        购买
      </Button>
    </div>
  );
}
