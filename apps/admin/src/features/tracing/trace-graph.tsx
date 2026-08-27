'use client';

import { useMemo, useState } from 'react';
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
import type { TraceSpanRow } from '@tillgate/api-client';

import { buildTraceGraph } from './graph';
import { SpanCard } from './span-card';
import { SpanDetailPanel } from './span-detail-panel';

/**
 * 路线图（React Flow）：节点=语义卡片（http/upstream/generic），边=父子实线 +
 * fallback 虚线动画；错误红框脉动；点击出属性侧栏。语义判定在 ./trace-graph
 * 的 buildTraceGraph（纯函数，本组件只渲染；语义与 observability 包同步，见该文件头注）。
 */

type SpanDetail = Parameters<typeof SpanDetailPanel>[0]['span'];

// dagre 从左到右自动布局
function layout(nodes: Node[], edges: Edge[]): Node[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90 });
  for (const node of nodes) graph.setNode(node.id, { width: 230, height: 92 });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return nodes.map((node) => {
    const pos = graph.node(node.id);
    return { ...node, position: { x: pos.x - 115, y: pos.y - 46 } };
  });
}

const nodeTypes = { spanCard: SpanCard };

export function TraceGraph({
  spans,
  totalMs,
  heightClass = 'h-[420px]',
}: {
  spans: TraceSpanRow[];
  totalMs: number;
  /** 画布高度（弹窗全屏时传更大值） */
  heightClass?: string;
}) {
  const t = useTranslations('tracing');
  const [selected, setSelected] = useState<SpanDetail | null>(null);
  const graph = useMemo(() => buildTraceGraph(spans), [spans]);

  const { nodes, edges } = useMemo(() => {
    const rfNodes: Node[] = graph.nodes.map((n: (typeof graph.nodes)[number]) => ({
      id: n.id,
      type: 'spanCard',
      data: { graphNode: n, span: spans.find((s) => s.spanId === n.id) },
      position: { x: 0, y: 0 },
    }));
    const rfEdges: Edge[] = graph.edges.map((e: (typeof graph.edges)[number]) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      animated: e.kind === 'fallback',
      style: e.kind === 'fallback' ? { strokeDasharray: '6 4', stroke: '#d97706' } : undefined,
      label: e.kind === 'fallback' ? 'fallback' : undefined,
      labelStyle: { fontSize: 10, fill: '#d97706' },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: e.kind === 'fallback' ? '#d97706' : '#71717a',
      },
    }));
    return { nodes: layout(rfNodes, rfEdges), edges: rfEdges };
  }, [graph, spans]);

  if (graph.nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noSpanData')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{t('summary', { count: graph.nodes.length, ms: Math.round(totalMs) })}</span>
        {graph.hasError ? (
          <span className="rounded bg-destructive/15 px-2 py-0.5 text-destructive">
            {t('errors', { count: graph.errorCount })}
          </span>
        ) : (
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-emerald-600">
            {t('allOk')}
          </span>
        )}
        <span className="ml-auto">
          <span className="mr-3">
            <span className="mr-1 inline-block h-0.5 w-6 bg-muted-foreground" /> {t('sequential')}
          </span>
          <span>
            <span className="mr-1 inline-block h-0.5 w-6 border-t-2 border-dashed border-amber-600" />
            {t('fallbackEdge')}
          </span>
        </span>
      </div>
      <div className={`${heightClass} overflow-hidden rounded-lg border`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.3}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            const span = node.data.span as SpanDetail | undefined;
            if (span) setSelected(span);
          }}
        >
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
          <Background gap={20} />
        </ReactFlow>
      </div>
      {selected ? <SpanDetailPanel span={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
