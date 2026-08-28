'use client';

// 预扣策略卡（system_configs billing_reservation_policy）：full 全额保守 / fixed
// 固定门槛厂商式（余额过门槛即放行，实际用量后付费，超出受透支地板封底）。
// 生效节奏 = 网关 TTL 缓存（默认 15s 内全网关拾取，无需重启）。

import { useEffect, useState, useTransition } from 'react';

import { Loader2Icon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@tillgate/ui';

import { useActionResult } from '@/components/action-toast';
import {
  getBillingReservationAction,
  getBillingReservationLimitAction,
  updateBillingReservationAction,
  updateBillingReservationLimitAction,
} from '@/server/settings-actions';

export function ReservationPolicyCard({ canUpdate }: { canUpdate: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<'full' | 'fixed'>('full');
  const [amount, setAmount] = useState('0.01');
  const [limit, setLimit] = useState('1000');
  const [limitLoaded, setLimitLoaded] = useState('1000');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [res, limitRes] = await Promise.all([
        getBillingReservationAction(),
        getBillingReservationLimitAction(),
      ]);
      if (alive && res.policy != null) {
        setMode(res.policy.mode);
        if (res.policy.amount != null) setAmount(res.policy.amount);
        setLoaded(true);
      }
      if (alive && limitRes.error === undefined) {
        setLimit(limitRes.limit);
        setLimitLoaded(limitRes.limit);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function saveLimit() {
    startTransition(async () => {
      const res = await updateBillingReservationLimitAction(limit).catch(() => null);
      if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) setLimitLoaded(limit);
    });
  }

  function save(nextMode: 'full' | 'fixed') {
    startTransition(async () => {
      const res = await updateBillingReservationAction(
        nextMode === 'fixed' ? { mode: 'fixed', amount } : { mode: 'full' },
      ).catch(() => null);
      if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) setMode(nextMode);
    });
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4" /> {t('reservationPolicy')}
        </CardTitle>
        <CardDescription>{t('reservationPolicyDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={mode === 'full' ? 'default' : 'outline'}
            disabled={!canUpdate || pending || (loaded && mode === 'full')}
            onClick={() => save('full')}
          >
            {pending && mode === 'full' && <Loader2Icon className="animate-spin" />}
            {t('reservationModeFull')}
          </Button>
          <Button
            size="sm"
            variant={mode === 'fixed' ? 'default' : 'outline'}
            disabled={!canUpdate || pending}
            onClick={() => save('fixed')}
          >
            {pending && mode === 'fixed' && <Loader2Icon className="animate-spin" />}
            {t('reservationModeFixed')}
          </Button>
          {mode === 'fixed' ? (
            <>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label={t('reservationAmount')}
                className="w-28 font-mono"
                inputMode="decimal"
                placeholder="0.01"
                disabled={!canUpdate}
              />
              <span className="text-sm text-muted-foreground">CNY</span>
            </>
          ) : null}
        </div>
        {canUpdate ? (
          <div className="flex items-center gap-2">
            <Input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              aria-label={t('reservationLimit')}
              className="w-32 font-mono"
              inputMode="decimal"
              placeholder="1000"
            />
            <span className="text-sm text-muted-foreground">CNY</span>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || limit === limitLoaded}
              onClick={saveLimit}
            >
              {pending && <Loader2Icon className="animate-spin" />}
              {t('reservationLimitSave')}
            </Button>
          </div>
        ) : (
          <p className="text-sm font-mono">{limit}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('reservationPolicyHint')}</p>
      </CardContent>
    </Card>
  );
}
