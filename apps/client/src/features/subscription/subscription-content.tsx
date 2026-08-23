'use client';

import { useLocale, useTranslations } from 'next-intl';

import { Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from '@tokenlens/ui';
import type { CurrentSubscription, OrgRow, PlanRow } from '@tokenlens/api-client';

import {
  CurrentSubscriptionCard,
  RenewButton,
  fmtYuan,
  usagePercent,
} from './current-subscription';
import { PlanCard } from './plan-actions';

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
  const t = useTranslations('subscription');
  const locale = useLocale();
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
                <CardTitle className="text-base">{t('currentTitle')}</CardTitle>
                <CardDescription>{t('currentDesc')}</CardDescription>
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
            <CardTitle className="text-base">{t('orgPlansTitle')}</CardTitle>
            <CardDescription>{t('orgPlansDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {orgs.map((o) => (
              <div key={o.orgId} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{o.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {o.planName ?? t('noPlan')}
                      {o.quantity != null ? ` · ${t('seatsBadge', { count: o.quantity })}` : ''}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    {o.remainingAmount != null ? (
                      <div className="text-xs text-muted-foreground">
                        {t('remainingQuota', { amount: fmtYuan(o.remainingAmount, locale) })}
                      </div>
                    ) : null}
                  </div>
                </div>
                {o.quotaAmount != null && o.usedAmount != null ? (
                  <div className="mt-2">
                    <Progress value={usagePercent(o.usedAmount, o.quotaAmount)} />
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t('usedQuota', {
                        used: fmtYuan(o.usedAmount, locale),
                        quota: fmtYuan(o.quotaAmount, locale),
                      })}
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
            <CardTitle className="text-base">{t('buyTitle')}</CardTitle>
            <CardDescription>{t('buyDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {plansError ? (
              <p className="text-sm text-destructive">{plansError}</p>
            ) : visiblePlans.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noPlans')}</p>
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
            <CardTitle className="text-base">{t('plansTitle')}</CardTitle>
            <CardDescription>{t('plansDesc')}</CardDescription>
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
