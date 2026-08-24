import { requirePermission } from '@/server/get-admin';
import { MegaphoneIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminApi } from '@/server/admin-api';
import { ListPage } from '@/components/list-page';

import { MarketingContent, type MarketingSettingsView } from '@/features/billing/marketing-content';

export const dynamic = 'force-dynamic';

export default async function MarketingPage() {
  await requirePermission('growth:read');
  const t = await getTranslations('marketing');
  const tc = await getTranslations('common');
  let settings: MarketingSettingsView | null = null;
  let error: string | null = null;
  try {
    settings = await adminApi().get<MarketingSettingsView>('/v1/marketing/settings');
  } catch (e) {
    error = e instanceof Error ? e.message : tc('loadFailed');
  }
  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<MegaphoneIcon className="size-5 text-muted-foreground" />}
      unbordered
    >
      <MarketingContent settings={settings} error={error} />
    </ListPage>
  );
}
