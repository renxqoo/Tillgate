"use client";

import { useTransition, useState } from "react";

import { Loader2Icon, SparklesIcon } from "lucide-react";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ai-gateway/ui/components/ui/dialog";
import { Input } from "@ai-gateway/ui/components/ui/input";
import { Progress } from "@ai-gateway/ui/components/ui/progress";

import { KeysSection } from "./keys-section";
import type { CurrentSubscription, PlanRow, SubKeyRow } from "../types";

/** 周期天数展示：30→月付，365→年付，其余按天。 */
function fmtPeriod(days: number): string {
  if (days === 30) return "月付";
  if (days === 365) return "年付";
  return `${days} 天`;
}

/** 元展示去尾零：¥100.0000 → ¥100，¥37.7258 → ¥37.7258（只用于整额/价格类展示）。 */
function fmtYuan(value: string): string {
  return formatMoney(value).replace(/\.?0+$/, "");
}

/** 积分展示去尾零：10000.00 → 10000，0.02 保持原样。 */
function fmtPoints(value: string): string {
  return formatPoints(value).replace(/\.?0+$/, "");
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
  keys,
  seats,
}: {
  readonly subscription: CurrentSubscription | null;
  readonly plans: ReadonlyArray<PlanRow>;
  readonly subError: string | null;
  readonly plansError: string | null;
  readonly keys: ReadonlyArray<SubKeyRow>;
  readonly seats: number;
}) {
  // 有订阅时只展示更高档（升级目标）；无订阅展示全部（开通）。
  const visiblePlans = subscription
    ? plans.filter((p) => (p.sortOrder ?? 0) > (subscription.planSortOrder ?? 0))
    : plans;

  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {subscription ? (
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="text-base">当前订阅</CardTitle>
                <CardDescription>套餐生效期与额度使用情况</CardDescription>
              </div>
              <RenewButton sub={subscription} />
            </div>
          </CardHeader>
          <CardContent>
            <CurrentSubscriptionCard sub={subscription} />
          </CardContent>
        </Card>
      ) : null}

      {subscription ? <KeysSection keys={keys} seats={seats} /> : null}

      {subError ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-destructive">{subError}</p>
          </CardContent>
        </Card>
      ) : !subscription ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">开通套餐</CardTitle>
            <CardDescription>选择套餐并开通订阅，余额支付，立即生效</CardDescription>
          </CardHeader>
          <CardContent>
            {plansError ? (
              <p className="text-sm text-destructive">{plansError}</p>
            ) : visiblePlans.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可购套餐</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visiblePlans.map((p) => (
                  <PlanCard key={p.id} plan={p} subscription={subscription} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : visiblePlans.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">套餐方案</CardTitle>
            <CardDescription>升级到更高层级套餐，余额支付补差价</CardDescription>
          </CardHeader>
          <CardContent>
            {plansError ? (
              <p className="text-sm text-destructive">{plansError}</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visiblePlans.map((p) => (
                  <PlanCard key={p.id} plan={p} subscription={subscription} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
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
          {sub.allowSeats ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              ×{sub.quantity} 席位
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {fmtDateTime(sub.startAt)} 至 {fmtDateTime(sub.endAt)}
        </span>
      </div>

      <div className="space-y-1.5">
        <Progress value={pct} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>已用 {pct.toFixed(1)}%</span>
          <span className="tabular-nums">
            剩余{" "}
            <span className="font-medium text-foreground">{fmtPoints(sub.remainingAmount)} 积分</span>
          </span>
        </div>
      </div>

      {sub.allowSeats ? <SeatUpgrade sub={sub} /> : null}
    </div>
  );
}

/** 续费按钮（位于「当前订阅」卡片右上角，与标题水平对齐），点击弹确认框。 */
function RenewButton({ sub }: { sub: CurrentSubscription }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const { renewSubscriptionAction } = await import("../actions");
      const res = await renewSubscriptionAction(sub.id);
      if (res.error) {
        toast.error("续费失败", { description: res.error });
        return;
      }
      toast.success("续费成功");
      setOpen(false);
    });
  }

  // 未到期续费：新订阅期从旧 endAt 顺延一个周期（活跃订阅恒 endAt > now）。
  const newEndAt = new Date(new Date(sub.endAt).getTime() + sub.periodDays * 86_400_000);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>续费</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认续费</DialogTitle>
          <DialogDescription>续费将按当前套餐与席位顺延一个周期</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <InfoRow label="套餐">
            {sub.planName}
            {sub.allowSeats ? `（×${sub.quantity} 席位）` : ""}
          </InfoRow>
          <InfoRow label="周期">{fmtPeriod(sub.periodDays)}</InfoRow>
          <InfoRow label="当前到期">{fmtDateTime(sub.endAt)}</InfoRow>
          <InfoRow label="续费后到期">{fmtDateTime(newEndAt.toISOString())}</InfoRow>
          <InfoRow label="续费金额" emphasize>
            ¥{fmtYuan(sub.renewPrice)}
          </InfoRow>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">取消</Button>
          </DialogClose>
          <Button disabled={pending} onClick={confirm}>
            {pending && <Loader2Icon className="animate-spin" />}确认续费
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({
  label,
  children,
  emphasize = false,
}: {
  label: string;
  children: React.ReactNode;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-right tabular-nums ${emphasize ? "font-semibold text-foreground" : "font-medium"}`}>
        {children}
      </span>
    </div>
  );
}

/** 团队套餐：在当前订阅基础上加席位。 */
function SeatUpgrade({ sub }: { sub: CurrentSubscription }) {
  const [seatQty, setSeatQty] = useState(String(sub.quantity + 1));
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 弹窗展示用席位（非法值回退到当前 +1）
  const qty = Math.max(sub.quantity + 1, Number(seatQty) || sub.quantity + 1);
  const total = Number(sub.planPrice) * qty;
  const diff = Math.max(0, total - Number(sub.remainingValue));

  function addSeat() {
    const n = Number(seatQty);
    if (!Number.isInteger(n) || n <= sub.quantity) {
      toast.error(`席位须大于当前（${sub.quantity}）`);
      return;
    }
    startTransition(async () => {
      const { changeSubscriptionAction } = await import("../actions");
      const res = await changeSubscriptionAction(sub.id, {
        targetPlanId: sub.planId,
        quantity: n,
      });
      if (res.error) {
        toast.error("扩容失败", { description: res.error });
        return;
      }
      toast.success("扩容成功");
      setOpen(false);
    });
  }

  return (
    <div className="flex items-center gap-2 border-t pt-4">
      <span className="text-xs text-muted-foreground">加席位</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">扩容</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认加席位</DialogTitle>
            <DialogDescription>按剩余价值补差价，席位只能增加</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">席位</label>
              <Input
                type="number"
                min={sub.quantity + 1}
                step="1"
                value={seatQty}
                onChange={(e) => setSeatQty(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <InfoRow label="席位">{sub.quantity} → {qty}</InfoRow>
              <InfoRow label="目标总价">¥{fmtYuan(String(total))}</InfoRow>
              <InfoRow label="剩余价值">¥{fmtYuan(sub.remainingValue)}</InfoRow>
              <InfoRow label="补差价" emphasize>¥{fmtYuan(String(diff))}</InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button disabled={pending} onClick={addSeat}>
              {pending && <Loader2Icon className="animate-spin" />}确认扩容
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlanCard({
  plan,
  subscription,
}: {
  plan: PlanRow;
  subscription: CurrentSubscription | null;
}) {
  // 卡片只出现在两种语境：无订阅→购买；有订阅→更高档→升级。
  const isUpgrade = subscription !== null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{plan.name}</span>
        <span className="text-xs text-muted-foreground">{fmtPeriod(plan.periodDays)}</span>
      </div>
      <div className="space-y-0.5">
        <div className="text-xs text-muted-foreground">
          价格{plan.allowSeats ? "（每席位）" : ""}
        </div>
        <div className="text-2xl font-semibold tabular-nums">¥{fmtYuan(plan.price)}</div>
        <div className="text-xs text-muted-foreground tabular-nums">{fmtPoints(plan.price)} 积分</div>
      </div>

      {isUpgrade ? (
        <UpgradeAction plan={plan} subscription={subscription!} />
      ) : (
        <PurchaseAction plan={plan} />
      )}
    </div>
  );
}

function PurchaseAction({ plan }: { plan: PlanRow }) {
  const [quantity, setQuantity] = useState("1");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 弹窗展示用席位（非法值回退到最小）
  const qty = Math.max(1, Number(quantity) || 1);
  const total = Number(plan.price) * qty;

  function purchase() {
    const n = Number(quantity);
    if (!Number.isInteger(n) || n < 1) {
      toast.error("席位至少为 1");
      return;
    }
    startTransition(async () => {
      const { purchaseSubscriptionAction } = await import("../actions");
      const res = await purchaseSubscriptionAction(plan.id, n);
      if (res.error) {
        toast.error("购买失败", { description: res.error });
        return;
      }
      toast.success("购买成功");
      setOpen(false);
    });
  }

  return (
    <div className="mt-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="w-full">购买</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认购买</DialogTitle>
            <DialogDescription>购买后立即开通订阅</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {plan.allowSeats ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">席位</label>
                <Input
                  type="number"
                  min={1}
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full"
                />
              </div>
            ) : null}
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <InfoRow label="套餐">
                {plan.name}
                {plan.allowSeats ? `（×${qty} 席位）` : ""}
              </InfoRow>
              <InfoRow label="周期">{fmtPeriod(plan.periodDays)}</InfoRow>
              <InfoRow label="应付金额" emphasize>¥{fmtYuan(String(total))}</InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button disabled={pending} onClick={purchase}>
              {pending && <Loader2Icon className="animate-spin" />}确认购买
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UpgradeAction({
  plan,
  subscription,
}: {
  plan: PlanRow;
  subscription: CurrentSubscription;
}) {
  const [quantity, setQuantity] = useState(String(subscription.quantity));
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // 弹窗展示用席位（非法值回退到当前席位）
  const qty = plan.allowSeats
    ? Math.max(subscription.quantity, Number(quantity) || subscription.quantity)
    : subscription.quantity;
  const total = Number(plan.price) * qty;
  const diff = Math.max(0, total - Number(subscription.remainingValue));

  function upgrade() {
    // 非席位套餐固定沿用当前席位；席位套餐不能少于当前（防缩容）
    const n = plan.allowSeats ? Number(quantity) : subscription.quantity;
    if (plan.allowSeats && (!Number.isInteger(n) || n < subscription.quantity)) {
      toast.error(`席位不能少于当前（${subscription.quantity}）`);
      return;
    }
    startTransition(async () => {
      const { changeSubscriptionAction } = await import("../actions");
      const res = await changeSubscriptionAction(subscription.id, {
        targetPlanId: plan.id,
        quantity: n,
      });
      if (res.error) {
        toast.error("升级失败", { description: res.error });
        return;
      }
      toast.success("升级成功");
      setOpen(false);
    });
  }

  return (
    <div className="mt-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="w-full">升级</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认升级</DialogTitle>
            <DialogDescription>按剩余价值补差价，只能升不能降</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {plan.allowSeats ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">席位</label>
                <Input
                  type="number"
                  min={subscription.quantity}
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full"
                />
              </div>
            ) : null}
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <InfoRow label="升级方案">
                {subscription.planName}
                {subscription.allowSeats ? `（×${subscription.quantity} 席位）` : ""} → {plan.name}
                {plan.allowSeats ? `（×${qty} 席位）` : ""}
              </InfoRow>
              <InfoRow label="目标总价">¥{fmtYuan(String(total))}</InfoRow>
              <InfoRow label="剩余价值">¥{fmtYuan(subscription.remainingValue)}</InfoRow>
              <InfoRow label="补差价" emphasize>¥{fmtYuan(String(diff))}</InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button disabled={pending} onClick={upgrade}>
              {pending && <Loader2Icon className="animate-spin" />}确认升级
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
