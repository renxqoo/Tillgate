'use client';

// 汇率管理卡（资金中心「汇率与币种」页签）：消费 control-plane fx 既有用例
// （状态/覆盖/清除/点差/强刷——审计在用例内）。高杠杆操作位由 funds:fx 权限门控。

import { useCallback, useEffect, useState, useTransition } from 'react';

import { ArrowDownUpIcon, Loader2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@tillgate/ui';

import { useActionResult } from '@/components/action-toast';
import {
  clearFxOverrideAction,
  getFxStateAction,
  refreshFxAction,
  setFxBufferAction,
  setFxOverrideAction,
} from '@/server/funds-actions';

interface FxStateView {
  mode: 'auto' | 'override';
  baseRate: string | null;
  effectiveRate: string | null;
  bufferPct: string;
  source: string | null;
  fetchedAt: string | null;
}

export function FxCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('funds');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<FxStateView | null>(null);
  const [overrideRate, setOverrideRate] = useState('');
  const [buffer, setBuffer] = useState('0');

  const reload = useCallback(async () => {
    const res = await getFxStateAction();
    if (res.state != null) {
      setState(res.state);
      setBuffer(res.state.bufferPct);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getFxStateAction();
      if (alive && res.state != null) {
        setState(res.state);
        setBuffer(res.state.bufferPct);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function run(action: () => Promise<{ ok?: true; error?: string }>) {
    startTransition(async () => {
      const res = await action().catch(() => null);
      if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) void reload();
    });
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowDownUpIcon className="size-4" /> {t('fxTitle')}
        </CardTitle>
        <CardDescription>{t('fxDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{t('fxMode')}</dt>
            <dd className="font-medium">{state ? t(state.mode === 'override' ? 'fxModeOverride' : 'fxModeAuto') : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('fxBase')}</dt>
            <dd className="font-mono">{state?.baseRate ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('fxEffective')}</dt>
            <dd className="font-mono">{state?.effectiveRate ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('fxFetchedAt')}</dt>
            <dd className="text-xs">{state?.fetchedAt ? new Date(state.fetchedAt).toLocaleString() : '—'}</dd>
          </div>
        </dl>

        {canManage ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={overrideRate}
                onChange={(e) => setOverrideRate(e.target.value)}
                aria-label={t('fxOverride')}
                className="w-32 font-mono"
                inputMode="decimal"
                placeholder={state?.baseRate ?? '7.2'}
                disabled={pending}
              />
              <Button size="sm" disabled={pending} onClick={() => run(() => setFxOverrideAction(overrideRate))}>
                {pending && <Loader2Icon className="animate-spin" />}
                {t('fxSetOverride')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || state?.mode !== 'override'}
                onClick={() => run(clearFxOverrideAction)}
              >
                <XCircleIcon /> {t('fxClearOverride')}
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(refreshFxAction)}>
                <RefreshCwIcon /> {t('fxRefresh')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={buffer}
                onChange={(e) => setBuffer(e.target.value)}
                aria-label={t('fxBuffer')}
                className="w-24 font-mono"
                inputMode="decimal"
                disabled={pending}
              />
              <span className="text-sm text-muted-foreground">%</span>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setFxBufferAction(buffer))}>
                {t('fxSetBuffer')}
              </Button>
            </div>
          </>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('fxHint')}</p>
      </CardContent>
    </Card>
  );
}
