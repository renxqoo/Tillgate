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
  // pageSize=目录单页上限：缺省 100 会截断下拉（目录 134+，新模型 id 靠后排后段——曾致新模型「无法获取」）
  const data = await apiFetch<{ models: PricingModel[] }>('/v1/pricing?pageSize=500').catch(() => null);
  const models = (data?.models ?? []).map((m) => m.externalName);

  return (
    <ListPage
      title="操练场"
      description="在控制台直接对话调试模型（按正常计费扣余额，流式输出）"
      icon={<FlaskConicalIcon className="size-5 text-muted-foreground" />}
      unbordered
    >
      <Playground models={models} />
    </ListPage>
  );
}
