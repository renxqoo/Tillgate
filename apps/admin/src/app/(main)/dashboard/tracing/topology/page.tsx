import Link from 'next/link';
import { Network } from 'lucide-react';
import { ApiError, adminFetch } from '@ai-gateway/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ai-gateway/ui/components/ui/card';
import { ChannelTopology, type ChannelHealth } from '../_components/channel-topology';

export const dynamic = 'force-dynamic';

export default async function TopologyPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  const requested = (await searchParams).hours;
  const hours = Math.min(168, Math.max(1, Number(requested) || 24));
  let channels: ChannelHealth[] = [];
  let error: string | null = null;
  try {
    const response = await adminFetch<{ channels: ChannelHealth[] }>(
      `/api/admin/tracing/topology?hours=${hours}`,
    );
    channels = response.channels;
  } catch (caught) {
    error = caught instanceof ApiError ? caught.message : '加载失败';
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Network className="size-5" />
          渠道健康拓扑
        </h1>
        <p className="text-sm text-muted-foreground">
          跨 trace 聚合（{hours}h 窗口）：网关 → 各渠道的调用量、成功率、延迟与最近错误。
          绿 ≥95% / 黄 ≥70% / 红 &lt;70%；错误率 ≥30% 的边有流动动画。
        </p>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>
            <Link href={`/dashboard/tracing/topology?hours=24`} className="mr-2 underline">
              24h
            </Link>
            <Link href={`/dashboard/tracing/topology?hours=168`} className="underline">
              7 天
            </Link>
            <Link href="/dashboard/tracing" className="ml-4 text-sm font-normal underline">
              ← 单 trace 视图
            </Link>
          </CardTitle>
          <CardDescription>点击节点可拖拽；minimap 缩略导航。</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? <p className="text-sm text-destructive">{error}</p> : <ChannelTopology channels={channels} />}
        </CardContent>
      </Card>
    </div>
  );
}
