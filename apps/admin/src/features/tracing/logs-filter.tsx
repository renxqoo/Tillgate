'use client';

import { Button, Input, NativeSelect, NativeSelectOption } from '@tillgate/ui';
import { useRouter, useSearchParams } from 'next/navigation';

import { FilterIcon, RotateCcwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function LogsFilter({
  from,
  to,
  userId,
  statusCode,
}: {
  from: string;
  to: string;
  userId: string;
  statusCode: string;
}) {
  const t = useTranslations('logs');
  const tc = useTranslations('common');
  const router = useRouter();
  const sp = useSearchParams();

  function apply(next: Record<string, string>) {
    const params = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.push(`?${params.toString()}`);
  }

  function reset() {
    const params = new URLSearchParams(sp.toString());
    params.delete('from');
    params.delete('to');
    params.delete('userId');
    params.delete('statusCode');
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted-foreground">{t('fromDate')}</label>
        <Input
          type="date"
          defaultValue={from}
          onChange={(e) => apply({ from: e.target.value })}
          className="w-40"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted-foreground">{t('toDate')}</label>
        <Input
          type="date"
          defaultValue={to}
          onChange={(e) => apply({ to: e.target.value })}
          className="w-40"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted-foreground">{tc('userId')}</label>
        <Input
          defaultValue={userId}
          placeholder={tc('optional')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply({ userId: (e.target as HTMLInputElement).value });
          }}
          className="w-32"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-muted-foreground">{t('statusCodeFilter')}</label>
        <div className="relative">
          <FilterIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <NativeSelect
            defaultValue={statusCode}
            onChange={(e) => apply({ statusCode: e.target.value })}
            className="w-36"
            selectClassName="pl-9"
          >
            <NativeSelectOption value="">{t('allStatusCodes')}</NativeSelectOption>
            <NativeSelectOption value="2xx">{t('status2xx')}</NativeSelectOption>
            <NativeSelectOption value="4xx">{t('status4xx')}</NativeSelectOption>
            <NativeSelectOption value="5xx">{t('status5xx')}</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      <Button variant="outline" onClick={reset}>
        <RotateCcwIcon data-icon="inline-start" /> {tc('reset')}
      </Button>
    </div>
  );
}
