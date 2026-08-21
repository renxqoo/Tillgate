"use client";

import { useTransition, useState } from "react";

import { Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

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

import type { CurrentSubscription, OrgRow, PlanRow } from "@ai-gateway/api-client/types";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

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
  orgs,
}: {
  readonly subscription: CurrentSubscription | null;
  readonly plans: ReadonlyArray<PlanRow>;
  readonly subError: string | null;
  readonly plansError: string | null;
  readonly orgs: ReadonlyArray<OrgRow>;
}) {
  const t = useTranslations("subscription");
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
                <CardTitle className="text-base">{t("currentTitle")}</CardTitle>
                <CardDescription>{t("currentDesc")}</CardDescription>
              </div>
              <RenewButton sub={subscription} />
            </div>
          </CardHeader>
          <CardContent>
            <CurrentSubscriptionCard sub={subscription} />
          </CardContent>
        </Card>
      ) : null}

      {orgs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("orgPlansTitle")}</CardTitle>
            <CardDescription>{t("orgPlansDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {orgs.map((o) => (
              <div key={o.orgId} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{o.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {o.planName ?? t("noPlan")}
                      {o.quantity != null ? ` · ${t("seatsBadge", { count: o.quantity })}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    {o.remainingAmount != null ? (
                      <div className="text-xs text-muted-foreground">
                        {t("remainingQuota", { amount: fmtPoints(o.remainingAmount) })}
                      </div>
                    ) : null}
                  </div>
                </div>
                {o.quotaAmount != null && o.usedAmount != null ? (
                  <div className="mt-2">
                    <Progress value={usagePercent(o.usedAmount, o.quotaAmount)} />
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("usedQuota", { used: fmtPoints(o.usedAmount), quota: fmtPoints(o.quotaAmount) })}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {subError ? (
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-destructive">{subError}</p>
          </CardContent>
        </Card>
      ) : !subscription ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("buyTitle")}</CardTitle>
            <CardDescription>{t("buyDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            {plansError ? (
              <p className="text-sm text-destructive">{plansError}</p>
            ) : visiblePlans.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noPlans")}</p>
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
            <CardTitle className="text-base">{t("plansTitle")}</CardTitle>
            <CardDescription>{t("plansDesc")}</CardDescription>
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
  const t = useTranslations("subscription");
  const tUi = useTranslations("ui");
  const pct = usagePercent(sub.usedAmount, sub.quotaAmount);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">{sub.planName}</span>
          {sub.allowSeats ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t("seatsBadge", { count: sub.quantity })}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">
          {t("periodRange", { start: fmtDateTime(sub.startAt), end: fmtDateTime(sub.endAt) })}
        </span>
      </div>

      <div className="space-y-1.5">
        <Progress value={pct} />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t("usedPercent", { pct: pct.toFixed(1) })}</span>
          <span className="tabular-nums">
            {t("remainingPoints")}{" "}
            <span className="font-medium text-foreground">{fmtPoints(sub.remainingAmount)} {tUi("points")}</span>
          </span>
        </div>
      </div>

      {sub.allowSeats ? <SeatUpgrade sub={sub} /> : null}
    </div>
  );
}

/** 续费按钮（位于「当前订阅」卡片右上角，与标题水平对齐），点击弹确认框。 */
function RenewButton({ sub }: { sub: CurrentSubscription }) {
  const t = useTranslations("subscription");
  const tUi = useTranslations("ui");
  const notify = useActionResult();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const { renewSubscriptionAction } = await import("../actions");
      const res = await renewSubscriptionAction(sub.id);
      if (!notify(res, t("renewFailed"), t("renewSuccessToast"))) return;
      setOpen(false);
    });
  }

  // 续费预览口径与服务端 renewalStart 一致：未到期从旧 endAt 顺延，已到期从 now 起算。
  // periodDays/endAt 异常缺失时兜底，绝不让 newEndAt 变 Invalid Date（toISOString 会抛 RangeError）。
  const oldEndTs = new Date(sub.endAt).getTime();
  const baseTs = Number.isFinite(oldEndTs) ? Math.max(oldEndTs, Date.now()) : Date.now();
  const periodMs = Number.isFinite(sub.periodDays) ? sub.periodDays * 86_400_000 : 0;
  const newEndAt = new Date(baseTs + periodMs);

  /** 周期天数展示：30→月付，365→年付，其余按天。 */
  const fmtPeriod = (days: number): string => {
    if (days === 30) return t("monthly");
    if (days === 365) return t("yearly");
    return t("periodDays", { days });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t("renew")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("renewTitle")}</DialogTitle>
          <DialogDescription>{t("renewDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <InfoRow label={t("labelPlan")}>
            {sub.planName}
            {sub.allowSeats ? ` ${t("seatsSuffix", { count: sub.quantity })}` : ""}
          </InfoRow>
          <InfoRow label={t("labelPeriod")}>{fmtPeriod(sub.periodDays)}</InfoRow>
          <InfoRow label={t("labelCurrentEnd")}>{fmtDateTime(sub.endAt)}</InfoRow>
          <InfoRow label={t("labelNewEnd")}>{fmtDateTime(newEndAt.toISOString())}</InfoRow>
          <InfoRow label={t("labelRenewAmount")} emphasize>
            ¥{fmtYuan(sub.renewPrice)}
          </InfoRow>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{tUi("cancel")}</Button>
          </DialogClose>
          <Button disabled={pending} onClick={confirm}>
            {pending && <Loader2Icon className="animate-spin" />}
            {t("confirmRenew")}
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
  const t = useTranslations("subscription");
  const tUi = useTranslations("ui");
  const notify = useActionResult();
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
      toast.error(t("seatsGreaterToast", { count: sub.quantity }));
      return;
    }
    startTransition(async () => {
      const { changeSubscriptionAction } = await import("../actions");
      const res = await changeSubscriptionAction(sub.id, {
        targetPlanId: sub.planId,
        quantity: n,
      });
      if (!notify(res, t("scaleFailedToast"), t("scaleSuccessToast"))) return;
      setOpen(false);
    });
  }

  return (
    <div className="flex items-center gap-2 border-t pt-4">
      <span className="text-xs text-muted-foreground">{t("addSeats")}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">{t("scaleUp")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("scaleTitle")}</DialogTitle>
            <DialogDescription>{t("scaleDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{t("labelSeats")}</label>
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
              <InfoRow label={t("labelSeats")}>{sub.quantity} → {qty}</InfoRow>
              <InfoRow label={t("labelTargetTotal")}>¥{fmtYuan(String(total))}</InfoRow>
              <InfoRow label={t("labelRemainingValue")}>¥{fmtYuan(sub.remainingValue)}</InfoRow>
              <InfoRow label={t("labelDiff")} emphasize>¥{fmtYuan(String(diff))}</InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tUi("cancel")}</Button>
            </DialogClose>
            <Button disabled={pending} onClick={addSeat}>
              {pending && <Loader2Icon className="animate-spin" />}
              {t("confirmScale")}
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
  const t = useTranslations("subscription");

  /** 周期天数展示：30→月付，365→年付，其余按天。 */
  const fmtPeriod = (days: number): string => {
    if (days === 30) return t("monthly");
    if (days === 365) return t("yearly");
    return t("periodDays", { days });
  };

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
          {plan.allowSeats ? t("pricePerSeatLabel") : t("priceLabel")}
        </div>
        <div className="text-2xl font-semibold tabular-nums">¥{fmtYuan(plan.price)}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {t("pointsValue", { points: fmtPoints(plan.price) })}
        </div>
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
  const t = useTranslations("subscription");
  const tUi = useTranslations("ui");
  const notify = useActionResult();
  const [quantity, setQuantity] = useState("1");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  /** 周期天数展示：30→月付，365→年付，其余按天。 */
  const fmtPeriod = (days: number): string => {
    if (days === 30) return t("monthly");
    if (days === 365) return t("yearly");
    return t("periodDays", { days });
  };

  // 弹窗展示用席位（非法值回退到最小）
  const qty = Math.max(1, Number(quantity) || 1);
  const total = Number(plan.price) * qty;

  function purchase() {
    const n = Number(quantity);
    if (!Number.isInteger(n) || n < 1) {
      toast.error(t("seatsAtLeast1"));
      return;
    }
    startTransition(async () => {
      const { purchaseSubscriptionAction } = await import("../actions");
      const res = await purchaseSubscriptionAction(plan.id, n);
      if (!notify(res, t("purchaseFailed"), t("purchaseSuccessToast"))) return;
      setOpen(false);
    });
  }

  return (
    <div className="mt-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="w-full">{t("purchase")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("purchaseTitle")}</DialogTitle>
            <DialogDescription>{t("purchaseDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {plan.allowSeats ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t("labelSeats")}</label>
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
              <InfoRow label={t("labelPlan")}>
                {plan.name}
                {plan.allowSeats ? ` ${t("seatsSuffix", { count: qty })}` : ""}
              </InfoRow>
              <InfoRow label={t("labelPeriod")}>{fmtPeriod(plan.periodDays)}</InfoRow>
              <InfoRow label={t("labelPayable")} emphasize>¥{fmtYuan(String(total))}</InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tUi("cancel")}</Button>
            </DialogClose>
            <Button disabled={pending} onClick={purchase}>
              {pending && <Loader2Icon className="animate-spin" />}
              {t("purchaseTitle")}
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
  const t = useTranslations("subscription");
  const tUi = useTranslations("ui");
  const notify = useActionResult();
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
      toast.error(t("seatsNotLessToast", { count: subscription.quantity }));
      return;
    }
    startTransition(async () => {
      const { changeSubscriptionAction } = await import("../actions");
      const res = await changeSubscriptionAction(subscription.id, {
        targetPlanId: plan.id,
        quantity: n,
      });
      if (!notify(res, t("upgradeFailedToast"), t("upgradeSuccessToast"))) return;
      setOpen(false);
    });
  }

  return (
    <div className="mt-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button className="w-full">{t("upgrade")}</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("upgradeTitle")}</DialogTitle>
            <DialogDescription>{t("upgradeDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {plan.allowSeats ? (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t("labelSeats")}</label>
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
              <InfoRow label={t("labelUpgradePath")}>
                {subscription.planName}
                {subscription.allowSeats ? ` ${t("seatsSuffix", { count: subscription.quantity })}` : ""} → {plan.name}
                {plan.allowSeats ? ` ${t("seatsSuffix", { count: qty })}` : ""}
              </InfoRow>
              <InfoRow label={t("labelTargetTotal")}>¥{fmtYuan(String(total))}</InfoRow>
              <InfoRow label={t("labelRemainingValue")}>¥{fmtYuan(subscription.remainingValue)}</InfoRow>
              <InfoRow label={t("labelDiff")} emphasize>¥{fmtYuan(String(diff))}</InfoRow>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{tUi("cancel")}</Button>
            </DialogClose>
            <Button disabled={pending} onClick={upgrade}>
              {pending && <Loader2Icon className="animate-spin" />}
              {t("confirmUpgrade")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
