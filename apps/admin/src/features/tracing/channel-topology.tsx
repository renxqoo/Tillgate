'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { useTranslations } from 'next-intl';
import '@xyflow/react/dist/style.css';

/**
 * 渠道健康拓扑（跨 trace 聚合）：网关 → 各渠道，按成功率着色，边标尝试数。
 * 数据来自 /v1/tracing/topology（trace_spans 聚合，24h 窗口）。
 * 节点高度按容器实测高度自适应分配（ResizeObserver），画布变高图一起变大。
 */

export interface ChannelHealth {
  channel: string;
  attempts: number;
  errors: number;
  avgDurationMs: number;
  lastAt: number | null;
  lastError: string | null;
  /** 窗口内预算预留尝试数（billing.reserve_channel span 数，含被拒——换渠占比分母） */
  reservations: number;
  /** 换渠切入数（预留携带 billing.switched=true——本渠道作为换渠目标） */
  switchedReservations: number;
}

const GATEWAY_W = 180;
const CHANNEL_W = 260;
const NODE_GAP = 36;
const ROW_MIN = 96;
const ROW_MAX = 240;

/** 容器高度 → 每个渠道节点的行高（网关同高居中对齐），让图纵向撑满画布 */
function rowHeightFor(containerH: number | null, count: number): number {
  if (!containerH || count <= 0) return 130;
  const row = Math.floor((containerH - 24 - NODE_GAP * (count - 1)) / count);
  return Math.max(ROW_MIN, Math.min(ROW_MAX, row));
}

function layout(nodes: Node[], edges: Edge[], rowH: number): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: NODE_GAP, ranksep: 140 });
  for (const node of nodes) {
    graph.setNode(node.id, { width: node.id === 'gateway' ? GATEWAY_W : CHANNEL_W, height: rowH });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return nodes.map((node) => {
    const pos = graph.node(node.id);
    return { ...node, position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 } };
  });
}

export function ChannelTopology({ channels }: { channels: ChannelHealth[] }) {
  const t = useTranslations('tracing');
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowH = rowHeightFor(containerH, channels.length);

  const { nodes, edges } = useMemo(() => {
    const builtNodes: Node[] = [
      {
        id: 'gateway',
        position: { x: 0, y: 0 },
        data: { label: 'gateway' },
        style: {
          width: GATEWAY_W,
          height: rowH,
          display: 'flex',
          alignItems: 'center',
          padding: 12,
          borderRadius: 10,
          border: '2px solid #71717a',
          background: '#18181b',
          color: '#ededed',
          fontSize: 14,
          fontWeight: 600,
        },
      },
      ...channels.map((ch) => {
        const successRate = ch.attempts > 0 ? 1 - ch.errors / ch.attempts : 1;
        let tone = '#dc2626';
        if (successRate >= 0.95) tone = '#059669';
        else if (successRate >= 0.7) tone = '#d97706';
        return {
          id: ch.channel,
          position: { x: 0, y: 0 },
          data: {
            label: `${ch.channel}\n${t('nodeLabel', { count: ch.attempts, rate: (successRate * 100).toFixed(1) })}\n${t('avgDelay', { ms: ch.avgDurationMs })}${
              ch.reservations > 0
                ? `\n${t('switchedIn', {
                    count: ch.switchedReservations,
                    rate: Math.round((ch.switchedReservations / ch.reservations) * 100),
                  })}`
                : ''
            }${ch.lastError ? `\n${t('lastError', { error: ch.lastError })}` : ''}`,
          },
          style: {
            width: CHANNEL_W,
            height: rowH,
            display: 'flex',
            alignItems: 'center',
            padding: 12,
            borderRadius: 10,
            border: `2px solid ${tone}`,
            background: '#18181b',
            color: '#ededed',
            fontSize: 12,
            whiteSpace: 'pre-line',
          },
        } satisfies Node;
      }),
    ];
    const builtEdges: Edge[] = channels.map((ch) => ({
      id: `gateway->${ch.channel}`,
      source: 'gateway',
      target: ch.channel,
      label: t('edgeAttempts', { count: ch.attempts }),
      labelStyle: { fontSize: 10, fill: '#a1a1aa' },
      animated: ch.errors > 0 && ch.attempts > 0 && ch.errors / ch.attempts >= 0.3,
      style: { stroke: ch.errors > 0 ? '#d97706' : '#52525b' },
      markerEnd: { type: MarkerType.ArrowClosed, color: ch.errors > 0 ? '#d97706' : '#52525b' },
    }));
    return { nodes: layout(builtNodes, builtEdges, rowH), edges: builtEdges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, rowH, t]);

  if (channels.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noTopologyData')}</p>;
  }

  return (
    <div ref={containerRef} className="h-full overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        // fitView 默认 maxZoom 1 会把图钉在 100%，渠道少时放开到 1.5 充分用画布；
        // padding 取小值：行高计算已按容器满高分配，大 padding 会反向缩小图形
        fitView
        fitViewOptions={{ padding: 0.02, maxZoom: 1.5 }}
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
        <Background gap={20} />
      </ReactFlow>
    </div>
  );
}
