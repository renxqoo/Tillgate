'use client';

// 视图/类型切换（select 形态——Radix Tabs 需容器且与 SSR 导航不搭，链接筛选是项目既有模式）

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

export function ReferralsViewSelect({ view, kind }: { view: string; kind: string }) {
  const t = useTranslations('referrals');
  const router = useRouter();
  const sp = useSearchParams();

  function change(key: 'view' | 'kind', value: string) {
    const next = new URLSearchParams(sp.toString());
    if (key === 'view') {
      next.set('view', value);
      if (value !== 'payouts') next.delete('kind');
      else if (!next.get('kind')) next.set('kind', 'commission');
    } else {
      next.set('view', 'payouts');
      next.set('kind', value);
    }
    next.delete('page');
    router.push(`/dashboard/referrals?${next.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <select
        onChange={(e) => change('view', e.target.value)}
        defaultValue={view}
        className="h-9 rounded-md border border-input bg-transparent px-3 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={t('view')}
      >
        <option value="relations">{t('relations')}</option>
        <option value="payouts">{t('payouts')}</option>
      </select>
      {view === 'payouts' ? (
        <select
          onChange={(e) => change('kind', e.target.value)}
          defaultValue={kind}
          className="h-9 rounded-md border border-input bg-transparent px-3 shadow-xs focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={t('payoutKind')}
        >
          <option value="commission">{t('dailyCommission')}</option>
          <option value="referral_signup">{t('referralSignup')}</option>
          <option value="gift">{t('signupGift')}</option>
        </select>
      ) : null}
    </div>
  );
}
