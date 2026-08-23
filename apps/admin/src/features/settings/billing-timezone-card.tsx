'use client';

import { useEffect, useState, useTransition } from 'react';

import { GlobeIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from '@tokenlens/ui';

import { useActionResult } from '@/components/action-toast';
import {
  getBillingTimezoneAction,
  updateBillingTimezoneAction,
} from '@/server/settings-actions';

/** 计费时区卡（system_configs billing_timezone）：schedule 分时段策略的墙钟口径，全系统统一 */
export function BillingTimezoneCard() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();
  const [timezone, setTimezone] = useState('');
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getBillingTimezoneAction().then((res) => {
      if (!alive) return;
      // null = 未配置（回落缺省 Asia/Shanghai——与网关 BILLING_TIMEZONE_DEFAULT 同口径展示）
      setTimezone(res.timezone ?? 'Asia/Shanghai');
      setLoaded(res.timezone ?? 'Asia/Shanghai');
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GlobeIcon className="size-4" /> {t('billingTimezone')}
        </CardTitle>
        <CardDescription>{t('billingTimezoneDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Asia/Shanghai"
            className="max-w-xs font-mono"
            aria-label={t('billingTimezone')}
          />
          <Button
            size="sm"
            disabled={pending || timezone.trim() === '' || timezone.trim() === loaded}
            onClick={() =>
              startTransition(async () => {
                const res = await updateBillingTimezoneAction(timezone.trim()).catch(() => null);
                if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) setLoaded(timezone.trim());
              })
            }
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {tc('save')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('billingTimezoneHint')}</p>
      </CardContent>
    </Card>
  );
}
