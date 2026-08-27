import { hasPerm, requirePermission } from '@/server/get-admin';
import { MegaphoneIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';

import { MarketingContent, type MarketingSettingsView } from '@/features/billing/marketing-content';

export const dynamic = 'force-dynamic';

export default async function MarketingPage() {
  const me = await requirePermission('growth:read');
  // 无 growth:update：保存钮隐藏、输入禁用（权限判定权威在后端 ACL）
  const canUpdate = hasPerm(me, 'growth:update');
  const t = await getTranslations('marketing');
  const tc = await getTranslations('common');
  let settings: MarketingSettingsView | null = null;
  let loadError: string | null = null;
  try {
    settings = await adminApi().get<MarketingSettingsView>('/v1/marketing/settings');
  } catch (error) {
    loadError = error instanceof Error ? error.message : tc('loadFailed');
  }
  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<MegaphoneIcon className="size-5 text-muted-foreground" />}
      unbordered
    >
      <MarketingContent settings={settings} error={loadError} canUpdate={canUpdate} />
    </ListPage>
  );
}
