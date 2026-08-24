'use client';

// 成员配额编辑弹层：日限额/月配额（空 = 不限），保存走 setMemberQuotaAction

import { useState, useTransition } from 'react';
import { Loader2Icon, PencilIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Input, Popover, PopoverContent, PopoverTrigger, toast } from '@tillgate/ui';
import type { OrgMemberRow, OrgRow } from '@tillgate/api-client';
import { actionResult } from '@/features/shared/action-result';
import { setMemberQuotaAction } from '@/server/actions/orgs';
import { fmtYuan, memberLabel, parseNullableMoney } from './orgs-shared';

export function QuotaCell({ org, member }: { org: OrgRow; member: OrgMemberRow }) {
  const t = useTranslations('orgs');
  const tCommon = useTranslations('common');
  const tUi = useTranslations('ui');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState(member.dailySpendLimit ?? '');
  const [monthly, setMonthly] = useState(member.monthlyQuota ?? '');
  const [pending, startTransition] = useTransition();

  const fmtLimit = (value: string | null): string => {
    if (value === null || value === '') return tCommon('unlimited');
    return fmtYuan(value, locale);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" />
        }
      >
        {t('quotaSummary', {
          daily: fmtLimit(member.dailySpendLimit),
          monthly: fmtLimit(member.monthlyQuota),
        })}
        <PencilIcon className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('quotaTitle', { name: memberLabel(member) })}</p>
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t('dailyLimitLabel')}</span>
              <Input
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                inputMode="decimal"
                placeholder={tCommon('unlimited')}
                className="h-8 text-xs"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t('monthlyQuotaLabel')}</span>
              <Input
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
                inputMode="decimal"
                placeholder={tCommon('unlimited')}
                className="h-8 text-xs"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t('quotaNote')}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {tUi('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  let dailyLimit: string | null;
                  let monthlyQuota: string | null;
                  try {
                    dailyLimit = parseNullableMoney(daily, tUi('invalidAmount'));
                    monthlyQuota = parseNullableMoney(monthly, tUi('invalidAmount'));
                  } catch (error) {
                    toast.error((error as Error).message);
                    return;
                  }
                  const res = await setMemberQuotaAction(org.orgId, member.userId, {
                    dailySpendLimit: dailyLimit,
                    monthlyQuota,
                  });
                  if (actionResult(res, tCommon('saveFailed'), t('savedToast'))) setOpen(false);
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />} {tCommon('save')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
