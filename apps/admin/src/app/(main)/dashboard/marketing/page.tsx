import { MegaphoneIcon } from 'lucide-react';

import { adminFetch } from '@ai-gateway/api-client';
import { ListPage } from '@ai-gateway/ui/components/list-page';

import { MarketingContent, type MarketingSettingsView } from './_components/marketing-content';

export const dynamic = 'force-dynamic';

export default async function MarketingPage() {
  let settings: MarketingSettingsView | null = null;
  let error: string | null = null;
  try {
    settings = await adminFetch<MarketingSettingsView>('/v1/marketing/settings');
  } catch (e) {
    error = e instanceof Error ? e.message : '加载失败';
  }
  return (
    <ListPage title="营销配置" description="拉新资金参数（注册赠送 / 邀请奖励 / 佣金比例）——改值即时生效，全程审计" icon={<MegaphoneIcon className="size-5 text-muted-foreground" />} unbordered>
      <MarketingContent settings={settings} error={error} />
    </ListPage>
  );
}
