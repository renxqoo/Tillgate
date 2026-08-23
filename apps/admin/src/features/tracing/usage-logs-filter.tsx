'use client';

import { Button, Input } from '@tokenlens/ui';
import { useRouter, useSearchParams } from 'next/navigation';

import { FilterIcon, SearchIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function UsageLogsFilter({
  from,
  to,
  userId,
  estimated,
}: {
  from: string;
  to: string;
  userId: string;
  estimated: string;
}) {
  const t = useTranslations('usageLogs');
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
    params.delete('estimated');
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('fromDate')}</label>
        <Input
          type="date"
          defaultValue={from}
          onChange={(e) => apply({ from: e.target.value })}
          className="h-9 w-40"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('toDate')}</label>
        <Input
          type="date"
          defaultValue={to}
          onChange={(e) => apply({ to: e.target.value })}
          className="h-9 w-40"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{tc('userId')}</label>
        <Input
          defaultValue={userId}
          placeholder={tc('optional')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply({ userId: (e.target as HTMLInputElement).value });
          }}
          className="h-9 w-32"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t('billingMethod')}</label>
        <div className="relative">
          <FilterIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <select
            defaultValue={estimated}
            onChange={(e) => apply({ estimated: e.target.value })}
            className="h-9 w-36 appearance-none rounded-md border border-input bg-transparent pl-9 pr-3 text-sm shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">{t('allBilling')}</option>
            <option value="true">{t('estimatedOnly')}</option>
            <option value="false">{t('actualOnly')}</option>
          </select>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={reset} className="h-9">
        <SearchIcon /> {tc('reset')}
      </Button>
    </div>
  );
}
