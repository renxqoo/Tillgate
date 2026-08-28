'use client';

import { useEffect, useState, useTransition } from 'react';

import { LandmarkIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@tillgate/ui';

import { useActionResult } from '@/components/action-toast';
import {
  applyDebitFloorDefaultAction,
  getDebitFloorDefaultAction,
  updateDebitFloorDefaultAction,
} from '@/server/settings-actions';

/** 透支地板全局默认卡（system_configs debit_floor_default）——新建钱包套用 + 批量刷默认基准 */
export function DebitFloorCard({ canUpdate }: { canUpdate: boolean }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const [applying, startApply] = useTransition();
  const [floor, setFloor] = useState('');
  const [loaded, setLoaded] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getDebitFloorDefaultAction();
      if (alive) {
        setFloor(res.floor);
        setLoaded(res.floor);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LandmarkIcon className="size-4" /> {t('debitFloor')}
        </CardTitle>
        <CardDescription>{t('debitFloorDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canUpdate ? (
          <>
            <div className="flex items-center gap-2">
              <Input
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                aria-label={t('debitFloor')}
                className="w-32 font-mono"
                inputMode="decimal"
                placeholder="0"
              />
              <span className="text-sm text-muted-foreground">CNY</span>
              <Button
                size="sm"
                disabled={pending || floor === loaded}
                onClick={() =>
                  startTransition(async () => {
                    const res = await updateDebitFloorDefaultAction(floor).catch(() => null);
                    if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) setLoaded(floor);
                  })
                }
              >
                {pending && <Loader2Icon className="animate-spin" />}
                {tc('save')}
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={applying}
              onClick={() =>
                startApply(async () => {
                  const res = await applyDebitFloorDefaultAction().catch(() => null);
                  setApplyResult(
                    res?.ok
                      ? t('debitFloorApplyResult', { applied: res.applied, skipped: res.skipped })
                      : t('debitFloorApplyFailed'),
                  );
                })
              }
            >
              {applying && <Loader2Icon className="animate-spin" />}
              {t('debitFloorApply')}
            </Button>
            {applyResult != null && <p className="text-xs text-muted-foreground">{applyResult}</p>}
          </>
        ) : (
          <p className="text-sm font-mono">{floor || '—'}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('debitFloorHint')}</p>
      </CardContent>
    </Card>
  );
}
