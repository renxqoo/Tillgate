'use client';

import { useEffect, useState, useTransition } from 'react';

import { GlobeIcon, Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  NativeSelect,
  NativeSelectOption,
  NativeSelectOptGroup,
} from '@tokenlens/ui';

import { useActionResult } from '@/components/action-toast';
import { getBillingTimezoneAction, updateBillingTimezoneAction } from '@/server/settings-actions';

/** 常用时区（置顶组；以运行时全量词表过滤，保证选项恒合法） */
const COMMON_TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
] as const;

/** 全量 IANA 词表（运行时 Intl 提供；不可用时退化为常用组） */
const ALL_TIMEZONES: readonly string[] = (() => {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] })
      .supportedValuesOf;
    return supported != null ? supported.call(Intl, 'timeZone') : [];
  } catch {
    return [];
  }
})();

const COMMON_PRESENT: readonly string[] = COMMON_TIMEZONES.filter((tz) =>
  ALL_TIMEZONES.length > 0 ? ALL_TIMEZONES.includes(tz) : true,
);
const REST_TIMEZONES = ALL_TIMEZONES.filter((tz) => !COMMON_PRESENT.includes(tz));

/** 选项表：常用组 + 其余全量组；当前值不在词表时补位（服务端已验 IANA，防御展示） */
function timezoneOptions(current: string): ReadonlyArray<{ group?: string; zones: string[] }> {
  const known = new Set([...COMMON_PRESENT, ...REST_TIMEZONES]);
  const extra = current !== '' && !known.has(current) ? [current] : [];
  return [
    { zones: [...COMMON_PRESENT] },
    ...(REST_TIMEZONES.length > 0 ? [{ zones: REST_TIMEZONES }] : []),
    ...(extra.length > 0 ? [{ zones: extra }] : []),
  ];
}

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
      const effective = res.timezone ?? 'Asia/Shanghai';
      setTimezone(effective);
      setLoaded(effective);
    });
    return () => {
      alive = false;
    };
  }, []);

  const groups = timezoneOptions(timezone);

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
          <NativeSelect
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            aria-label={t('billingTimezone')}
            className="w-64"
            selectClassName="font-mono"
          >
            {groups.map((group, gi) =>
              gi === 0 ? (
                <NativeSelectOptGroup key={`g${gi}`} label={t('timezoneCommonGroup')}>
                  {group.zones.map((tz) => (
                    <NativeSelectOption key={tz} value={tz}>
                      {tz}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ) : (
                <NativeSelectOptGroup key={`g${gi}`} label={t('timezoneAllGroup')}>
                  {group.zones.map((tz) => (
                    <NativeSelectOption key={tz} value={tz}>
                      {tz}
                    </NativeSelectOption>
                  ))}
                </NativeSelectOptGroup>
              ),
            )}
          </NativeSelect>
          <Button
            size="sm"
            disabled={pending || timezone === '' || timezone === loaded}
            onClick={() =>
              startTransition(async () => {
                const res = await updateBillingTimezoneAction(timezone).catch(() => null);
                if (notify(res ?? {}, tc('actionFailed'), tc('saved'))) setLoaded(timezone);
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
