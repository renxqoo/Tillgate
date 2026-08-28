'use client';

// 平台币种卡（写一次配置）：展示当前记账币种;仅处女系统（无账本/渠道资金/用量）
// 可改——非处女由后端 409 锁定并透传原因。换币 = 显式迁移,不是运营配置。

import { useEffect, useState, useTransition } from 'react';

import { CoinsIcon, Loader2Icon } from 'lucide-react';
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
import { getPlatformCurrencyAction, updatePlatformCurrencyAction } from '@/server/funds-actions';

export function CurrencyCard({ canManage }: { canManage: boolean }) {
  const t = useTranslations('funds');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const [currency, setCurrency] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getPlatformCurrencyAction();
      if (alive && res.currency != null) {
        setCurrency(res.currency);
        setDraft(res.currency);
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
          <CoinsIcon className="size-4" /> {t('currencyTitle')}
        </CardTitle>
        <CardDescription>{t('currencyDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xl font-mono font-semibold">{currency ?? '—'}</p>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              aria-label={t('currencyTitle')}
              className="w-24 font-mono uppercase"
              maxLength={3}
              disabled={pending}
            />
            <Button
              size="sm"
              disabled={pending || draft === currency}
              onClick={() =>
                startTransition(async () => {
                  const res = await updatePlatformCurrencyAction(draft).catch(() => null);
                  if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) setCurrency(draft);
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />}
              {tc('save')}
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('currencyHint')}</p>
      </CardContent>
    </Card>
  );
}
