'use client';

// 上游消失清单：绑定到本源渠道但目录已无的对外名（复核下架）；>8 条折叠为省略列表

import { useTranslations } from 'next-intl';

export function CatalogGoneList({
  gone,
}: {
  gone: Array<{ mappingId: number; externalName: string; realModel: string }>;
}) {
  const t = useTranslations('modelMarket');
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <span className="font-medium text-amber-600">{t('goneTitle', { count: gone.length })}</span>
      <span className="ml-2 text-muted-foreground">
        {gone.length > 8
          ? `${t('goneListMore', {
              list: gone
                .slice(0, 8)
                .map((g) => g.externalName)
                .join(', '),
              count: gone.length,
            })}${t('goneSuffix')}`
          : `${gone
              .slice(0, 8)
              .map((g) => g.externalName)
              .join(', ')}${t('goneSuffix')}`}
      </span>
    </div>
  );
}
