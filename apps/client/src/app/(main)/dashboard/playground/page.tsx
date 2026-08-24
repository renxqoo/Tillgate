import { FlaskConicalIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import type { PricingPage } from '@tillgate/api-client';

import { Playground } from '@/features/playground/playground';
import { ListPage } from '@/features/shared/list-page';
import { createClientApi } from '@/server/api';
import { requireMe } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function PlaygroundPage() {
  const t = await getTranslations('playground');
  const api = createClientApi();
  await requireMe(api);
  // pageSize=目录单页上限：缺省 100 会截断下拉（目录可达数百，新模型 id 靠后排后段，截断即「无法获取」）
  const data = await api.get<PricingPage>('/v1/pricing?pageSize=500').catch(() => null);
  const models = (data?.models ?? []).map((m) => m.externalName);

  return (
    <ListPage
      title={t('title')}
      description={t('description')}
      icon={<FlaskConicalIcon className="size-5 text-muted-foreground" />}
      unbordered
    >
      <Playground models={models} />
    </ListPage>
  );
}
