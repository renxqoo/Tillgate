import { requirePermission } from '@/server/get-admin';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@tillgate/ui';
import Link from 'next/link';
import { Store } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';
import { ApiError } from '@tillgate/api-client';
import { adminApi } from '@/server/admin-api';
import { CatalogContent, type CatalogItem, type FxState } from '@/features/models/catalog-content';

export const dynamic = 'force-dynamic';

/**
 * 模型市场：多源货架（渠道型 = 可接入上游；字典型 = 行业参考，导入落草稿 +
 * 按模型 provider 前缀 find-or-create 对应渠道并绑定）。
 * 三态 diff（新增/上游涨价/上游降价）+ USD 预填换算（自动汇率 × 点差）+ 汇率追溯条。
 */
/** 已知目录源的显示名目录键；未知源回落后端原始 name（新源零成本兼容） */
const SOURCE_NAME_KEYS: Record<string, string> = { 'models-dev': 'sourceModelsDev' };

/** 源提示语：渠道型按就绪状态给接入/需密钥提示；字典型给参考提示 */
function sourceHint(ctx: {
  active: { id: string; name: string; kind: 'channel' | 'reference' } | null;
  channelReady: boolean;
  t: Awaited<ReturnType<typeof getTranslations<'modelMarket'>>>;
  label: (src: { id: string; name: string }) => string;
}): string {
  const { active, channelReady, t, label } = ctx;
  if (active?.kind === 'channel') {
    return channelReady
      ? t('channelReadyText', { name: label(active) })
      : t('needsKeyText', { name: label(active) });
  }
  if (active?.kind === 'reference') {
    return t('referenceHint');
  }
  return '';
}

export default async function ModelMarketPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  await requirePermission('catalog:read');
  const params = await searchParams;
  const t = await getTranslations('modelMarket');
  const sourceLabel = (src: { id: string; name: string }): string => {
    const key = SOURCE_NAME_KEYS[src.id];
    return key ? t(key) : src.name;
  };
  let sources: Array<{
    id: string;
    name: string;
    kind: 'channel' | 'reference';
    priceCurrency: 'USD' | 'CNY';
    needsKey: boolean;
  }> = [];
  try {
    const data = await adminApi().get<{ sources: typeof sources }>('/v1/model-catalog/sources');
    ({ sources } = data);
  } catch {
    sources = [];
  }
  const active = sources.find((src) => src.id === params.source) ?? sources[0] ?? null;

  let items: CatalogItem[] = [];
  let gone: Array<{ mappingId: number; externalName: string; realModel: string }> = [];
  let fetchedAt = '';
  let channelReady = false;
  let fx: FxState | null = null;
  let loadError: string | null = null;
  if (active) {
    try {
      const data = await adminApi().get<{
        items: CatalogItem[];
        gone: typeof gone;
        fetchedAt: string;
        channelReady: boolean;
        fx: FxState;
      }>(`/v1/model-catalog/${active.id}`);
      ({ items, fetchedAt, channelReady, fx } = data);
      gone = data.gone ?? [];
    } catch (error) {
      loadError = error instanceof ApiError ? error.message : t('fetchFailed');
    }
  }
  const activeHint = sourceHint({ active, channelReady, t, label: sourceLabel });

  let catalogContent = (
    <p className="py-8 text-center text-sm text-muted-foreground">{t('noSources')}</p>
  );
  if (active) {
    catalogContent = (
      <CatalogContent
        sourceId={active.id}
        sourceName={sourceLabel(active)}
        sourceKind={active.kind}
        currency={active.priceCurrency}
        items={items}
        gone={gone}
        fetchedAt={fetchedAt}
        channelReady={channelReady}
        needsKey={active.needsKey}
        fx={fx}
      />
    );
  }
  if (loadError) {
    catalogContent = (
      <p className="py-8 text-center text-sm text-destructive">
        {loadError}
        {t('retryLater')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Store className="size-5" />
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('description')}
          <Link href="/dashboard/models" className="ml-2 underline">
            {t('modelsLink')}
          </Link>
        </p>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>{t('shelf')}</CardTitle>
          <CardDescription>
            {sources.length > 1 ? (
              <span className="mr-4 inline-flex gap-1">
                {sources.map((src) => (
                  <Link
                    key={src.id}
                    href={`/dashboard/model-market?source=${src.id}`}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-xs',
                      src.id === active?.id
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70',
                    )}
                  >
                    {sourceLabel(src)}
                    {src.kind === 'reference' ? t('draftSuffix') : ''}
                  </Link>
                ))}
              </span>
            ) : null}
            {activeHint}
          </CardDescription>
        </CardHeader>
        <CardContent>{catalogContent}</CardContent>
      </Card>
    </div>
  );
}
