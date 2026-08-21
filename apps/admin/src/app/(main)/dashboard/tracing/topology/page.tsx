import Link from 'next/link';
import { Network } from 'lucide-react';
import { ApiError, adminFetch } from '@ai-gateway/api-client';
import { Card, CardContent } from '@ai-gateway/ui/components/ui/card';
import { ChannelTopology, type ChannelHealth } from '../_components/channel-topology';

/** 渠道首token延迟聚合行（/v1/analytics/channel-ttft） */
interface TtftRow {
  channelId: number | null;
  channelName: string | null;
  samples: number;
  upstreamP50: number | null;
  upstreamP95: number | null;
  clientP50: number | null;
  clientP95: number | null;
}

/** ms → 秒展示（两位小数；null = 无样本） */
const sec = (ms: number | null) => (ms != null ? `${(ms / 1000).toFixed(2)}s` : '—');

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
  let ttftRows: TtftRow[] = [];
  let ttftError: string | null = null;
  try {
    // 主图与次要 TTFT 表独立降级：次要端点失败不拖垮主视图（部署漂移时新查询可能 500）
    const [topology, ttft] = await Promise.allSettled([
      adminFetch<{ channels: ChannelHealth[] }>(`/v1/tracing/topology?hours=${hours}`),
      adminFetch<{ rows: TtftRow[] }>(`/v1/analytics/channel-ttft?hours=${hours}`),
    ]);
    if (topology.status === 'fulfilled') channels = topology.value.channels;
    else error = topology.reason instanceof ApiError ? topology.reason.message : '加载失败';
    if (ttft.status === 'fulfilled') ttftRows = ttft.value.rows;
    else ttftError = '首token数据暂不可用';
  } catch (caught) {
    error = caught instanceof ApiError ? caught.message : '加载失败';
  }

  return (
    // 满高：扣除顶栏 3rem 与内容区上下 padding（p-4 / md:p-6）；
    // 标题行压缩为一行（窗口切换并入），把可视高度尽量留给 flow 图
    <div className="flex h-[calc(100svh-5rem)] flex-col gap-3 md:h-[calc(100svh-6rem)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Network className="size-4" />
          渠道健康拓扑
        </h1>
        <nav className="flex items-center gap-3 text-sm">
          <Link
            href={`/dashboard/tracing/topology?hours=24`}
            className={hours === 24 ? 'font-semibold underline' : 'underline'}
          >
            24h
          </Link>
          <Link
            href={`/dashboard/tracing/topology?hours=168`}
            className={hours === 168 ? 'font-semibold underline' : 'underline'}
          >
            7 天
          </Link>
          <Link href="/dashboard/tracing" className="underline">
            ← 单 trace 视图
          </Link>
        </nav>
        <p className="w-full text-xs text-muted-foreground">
          跨 trace 聚合（{hours}h 窗口）：网关 → 各渠道的调用量、成功率、延迟与最近错误。绿 ≥95% /
          黄 ≥70% / 红 &lt;70%；错误率 ≥30% 的边有流动动画。点击节点可拖拽，minimap 缩略导航。
        </p>
      </div>
      <Card className="min-h-0 flex-1 overflow-hidden py-3">
        <CardContent className="min-h-0 flex-1">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <ChannelTopology channels={channels} />
          )}
        </CardContent>
      </Card>
      {ttftRows.length > 0 && (
        <Card className="max-h-56 shrink-0 overflow-auto py-3">
          <CardContent>
            {ttftError && <p className="mb-2 text-xs text-destructive">{ttftError}</p>}
            <p className="mb-2 text-xs text-muted-foreground">
              渠道首token延迟（{hours}h 流式样本，P50/P95）——上游 = 尝试发出 → 上游首字节；客户 =
              管道进入 → 首token交付。差值大 = 换渠重试多。
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">渠道</th>
                  <th className="py-1 text-right font-medium">样本</th>
                  <th className="py-1 text-right font-medium">上游 P50</th>
                  <th className="py-1 text-right font-medium">上游 P95</th>
                  <th className="py-1 text-right font-medium">客户 P50</th>
                  <th className="py-1 text-right font-medium">客户 P95</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {ttftRows.map((r) => (
                  <tr key={r.channelId ?? r.channelName ?? 'unknown'} className="border-t">
                    <td className="py-1">{r.channelName ?? `#${r.channelId ?? '—'}`}</td>
                    <td className="py-1 text-right">{r.samples}</td>
                    <td className="py-1 text-right">{sec(r.upstreamP50)}</td>
                    <td className="py-1 text-right text-muted-foreground">{sec(r.upstreamP95)}</td>
                    <td className="py-1 text-right">{sec(r.clientP50)}</td>
                    <td className="py-1 text-right text-muted-foreground">{sec(r.clientP95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
