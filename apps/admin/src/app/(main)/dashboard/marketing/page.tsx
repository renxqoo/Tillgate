import { MegaphoneIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { adminFetch } from '@ai-gateway/api-client';
import { ListPage } from '@ai-gateway/ui/components/list-page';

import { MarketingContent, type MarketingSettingsView } from './_components/marketing-content';

export const dynamic = 'force-dynamic';

export default async function MarketingPage() {
  const t = await getTranslations('marketing');
  const tc = await getTranslations('common');
  let settings: MarketingSettingsView | null = null;
  let error: string | null = null;
  try {
    settings = await adminFetch<MarketingSettingsView>('/v1/marketing/settings');
  } catch (e) {
    error = e instanceof Error ? e.message : tc('loadFailed');
  }
  return (
    <ListPage title={t('title')} description={t('description')} icon={<MegaphoneIcon className="size-5 text-muted-foreground" />} unbordered>
      <MarketingContent settings={settings} error={error} />
    </ListPage>
  );
}
