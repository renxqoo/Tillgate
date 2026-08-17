import { FlaskConicalIcon } from 'lucide-react';

import { apiFetch } from '@ai-gateway/api-client';
import { ListPage } from '@ai-gateway/ui/components/list-page';

import { Playground } from './_components/playground';

export const dynamic = 'force-dynamic';

interface PricingModel {
  id: number;
  externalName: string;
  pricingUnit: string;
  isFree: boolean;
}

export default async function PlaygroundPage() {
  const data = await apiFetch<{ models: PricingModel[] }>('/api/pricing').catch(() => null);
  const models = (data?.models ?? []).map((m) => m.externalName);

  return (
    <ListPage
      title="操练场"
      description="在控制台直接对话调试模型（按正常计费扣余额，流式输出）"
      icon={<FlaskConicalIcon className="size-5 text-muted-foreground" />}
    >
      <Playground models={models} />
    </ListPage>
  );
}
