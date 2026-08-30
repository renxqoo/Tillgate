'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@tillgate/ui';

/**
 * 渠道观测窗口切换（1h/24h——API windowMs 已支持 1h..24h，此为前端入口）。
 * 走 URL `?window=`（GET 可分享/可刷新），1h 为缺省不落参数；切换保留排序等其余参数。
 */
export function OverviewWindowToggle({ windowHours }: { windowHours: 1 | 24 }) {
  const t = useTranslations('routing');
  const router = useRouter();
  const sp = useSearchParams();

  function apply(next: 1 | 24): void {
    if (next === windowHours) return;
    const params = new URLSearchParams(sp.toString());
    if (next === 24) params.set('window', '24h');
    else params.delete('window'); // 1h 是缺省态——不留冗余参数
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        size="xs"
        variant={windowHours === 1 ? 'secondary' : 'ghost'}
        onClick={() => apply(1)}
      >
        {t('window1h')}
      </Button>
      <Button
        size="xs"
        variant={windowHours === 24 ? 'secondary' : 'ghost'}
        onClick={() => apply(24)}
      >
        {t('window24h')}
      </Button>
    </div>
  );
}
