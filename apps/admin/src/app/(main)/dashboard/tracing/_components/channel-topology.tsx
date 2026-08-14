'use client';

import { useMemo } from 'react';
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
import '@xyflow/react/dist/style.css';

/**
 * 渠道健康拓扑（跨 trace 聚合）：网关 → 各渠道，按成功率着色，边标尝试数。
 * 数据来自 /api/admin/tracing/topology（trace_spans 聚合，24h 窗口）。
 */

export interface ChannelHealth {
  channel: string;
  attempts: number;
  errors: number;
  avgDurationMs: number;
  lastAt: number | null;
  lastError: string | null;
}

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 140 });
  for (const node of nodes) graph.setNode(node.id, { width: node.id === 'gateway' ? 180 : 240, height: 110 });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return nodes.map((node) => {
    const pos = graph.node(node.id);
    return { ...node, position: { x: pos.x - 120, y: pos.y - 55 } };
  });
}

export function ChannelTopology({ channels }: { channels: ChannelHealth[] }) {
  const { nodes, edges } = useMemo(() => {
    const builtNodes: Node[] = [
      {
        id: 'gateway',
        position: { x: 0, y: 0 },
        data: { label: 'gateway' },
        style: {
          width: 180,
          padding: 12,
          borderRadius: 10,
          border: '2px solid #71717a',
          background: '#18181b',
          color: '#ededed',
          fontSize: 13,
          fontWeight: 600,
        },
      },
      ...channels.map((ch) => {
        const successRate = ch.attempts > 0 ? 1 - ch.errors / ch.attempts : 1;
        const tone =
          successRate >= 0.95 ? '#059669' : successRate >= 0.7 ? '#d97706' : '#dc2626';
        return {
          id: ch.channel,
          position: { x: 0, y: 0 },
          data: {
            label: `${ch.channel}\n${ch.attempts} 次 · 成功率 ${(successRate * 100).toFixed(1)}%\n均延迟 ${ch.avgDurationMs}ms${
              ch.lastError ? `\n最近错误: ${ch.lastError}` : ''
            }`,
          },
          style: {
            width: 240,
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
      label: `${ch.attempts} 次`,
      labelStyle: { fontSize: 10, fill: '#a1a1aa' },
      animated: ch.errors > 0 && ch.attempts > 0 && ch.errors / ch.attempts >= 0.3,
      style: { stroke: ch.errors > 0 ? '#d97706' : '#52525b' },
      markerEnd: { type: MarkerType.ArrowClosed, color: ch.errors > 0 ? '#d97706' : '#52525b' },
    }));
    return { nodes: layout(builtNodes, builtEdges), edges: builtEdges };
  }, [channels]);

  if (channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        窗口内无渠道调用数据（需要各服务已接 trace-receiver 且有真实流量）。
      </p>
    );
  }

  return (
    <div className="h-full overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
        <Background gap={20} />
      </ReactFlow>
    </div>
  );
}
