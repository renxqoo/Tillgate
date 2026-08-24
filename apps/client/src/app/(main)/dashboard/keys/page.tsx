import { KeyRoundIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import type { CurrentSubscription, KeyRow, OrgRow, RowsPage } from '@tillgate/api-client';
import { ApiError } from '@tillgate/api-client';

import { ListPage } from '@/features/shared/list-page';
import { parseListSearchParams } from '@/server/list-query';
import { CreateKeyDialog } from '@/features/keys/create-key-dialog';
import { KeysTable } from '@/features/keys/keys-content';
import { ExportKeys } from '@/features/keys/export-keys';
import { isDevFakeMe } from '@/config/dev';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function KeysPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const t = await getTranslations('keys');
  const tCommon = await getTranslations('common');
  const { page } = parseListSearchParams(sp);
  const api = createClientApi();
  await requireMe(api);

  let keys: KeyRow[] = [];
  let total = 0;
  let loadError: string | null = null;
  const subscriptions: Array<{ id: number; label: string }> = [];
  try {
    const result = await api.list<KeyRow>('/v1/keys', { page, pageSize: PAGE_SIZE });
    // catch 形参按 catch-error-name 规则命名为 error，外层改名为 loadError（原写法 error 恒为 null，失败提示不上屏）
    ({ rows: keys, total } = result);
  } catch (error) {
    loadError = error instanceof ApiError ? error.message : t('loadFailed');
  }
  // 计费来源下拉：个人订阅 + 所属组织订阅（含余额选项，由弹窗固定渲染）。
  try {
    const subResult = await api.get<RowsPage<CurrentSubscription>>('/v1/subscriptions');
    const sub: CurrentSubscription | null = subResult.rows[0] ?? null;
    if (sub) subscriptions.push({ id: sub.id, label: sub.planName });
  } catch {
    // 拿不到个人订阅不影响创建
  }
  try {
    const orgs = await api.get<RowsPage<OrgRow>>('/v1/orgs');
    for (const o of orgs.rows) {
      if (o.subscriptionId != null) {
        subscriptions.push({
          id: o.subscriptionId,
          label: `${o.name} · ${o.planName ?? t('planFallback')}`,
        });
      }
    }
  } catch {
    // 拿不到组织订阅不影响创建
  }

  const subscriptionLabels = new Map<number, string>(subscriptions.map((s) => [s.id, s.label]));

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      {isDevFakeMe() && (
        <p className="text-xs text-amber-600 bg-amber-500/10 px-3 py-1.5 rounded-md ring-1 ring-amber-500/30">
          ⚠️ {tCommon('devMockNotice')}
        </p>
      )}

      <ListPage
        title={t('title')}
        icon={<KeyRoundIcon className="size-5 text-muted-foreground" />}
        total={total}
        totalUnit={t('totalUnit')}
        searchParams={{ page: page > 1 ? String(page) : undefined }}
        filters={<ExportKeys />}
        actions={<CreateKeyDialog subscriptions={subscriptions} />}
        error={loadError}
        page={page}
        pageSize={PAGE_SIZE}
      >
        <KeysTable keys={keys} subscriptionLabels={subscriptionLabels} />
      </ListPage>
    </div>
  );
}
