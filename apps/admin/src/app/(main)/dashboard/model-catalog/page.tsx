import Link from 'next/link';
import { Store } from 'lucide-react';
import { ApiError, adminFetch } from '@ai-gateway/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import { CatalogContent, type CatalogItem } from './_components/catalog-content';

export const dynamic = 'force-dynamic';

/**
 * 模型目录：拉取 OpenRouter 免费模型（10min 缓存在 admin-api），
 * 勾选一键入库为 provider/channel/model 三层（复用既有实体，无新概念）。
 * 护栏：价格必填（默认平台价）、渠道 rpm 预填 20、free- 渠道名、key 首次必填。
 */
export default async function ModelCatalogPage() {
  let items: CatalogItem[] = [];
  let fetchedAt = '';
  let channelReady = false;
  let error: string | null = null;
  try {
    const data = await adminFetch<{
      items: CatalogItem[];
      fetchedAt: string;
      channelReady: boolean;
    }>('/api/admin/model-catalog/openrouter');
    items = data.items;
    fetchedAt = data.fetchedAt;
    channelReady = data.channelReady;
  } catch (caught) {
    error = caught instanceof ApiError ? caught.message : '目录拉取失败';
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Store className="size-5" />
          模型目录
        </h1>
        <p className="text-sm text-muted-foreground">
          OpenRouter 免费模型一键入库（自动获取最新目录）；
          作为免费/测试档供给——对外只显示你定的对外名（白标）。
          <Link href="/dashboard/models" className="ml-2 underline">
            模型映射 →
          </Link>
        </p>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>免费模型</CardTitle>
          <CardDescription>
            {channelReady
              ? '免费渠道已就绪，直接勾选导入。'
              : '首次导入需填写平台 API Key（创建渠道 free-openrouter，AES 加密存储）。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="py-8 text-center text-sm text-destructive">{error}（稍后刷新重试）</p>
          ) : (
            <CatalogContent items={items} fetchedAt={fetchedAt} channelReady={channelReady} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
