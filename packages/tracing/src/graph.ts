import type { SpanRow } from './types.js';

/**
 * spans → 路线图视图模型（纯函数，零展示层依赖）。
 *
 * 展示层（React Flow 等）只做渲染，语义判定全部在这里：
 *   - 节点 kind：http（根/带 http 属性）/ upstream（渠道调用）/ generic
 *   - 状态：statusCode=2 → error
 *   - 同父多兄弟 = 渠道尝试链：首个接父边，其余链式 fallback 边
 *     （网关候选循环成功即停，因此 2 个以上兄弟必为换渠道重试）
 */

export type GraphNodeKind = 'http' | 'upstream' | 'generic';
export type GraphNodeStatus = 'ok' | 'error' | 'unset';

export interface GraphNode {
  /** spanId（同时是图节点 id） */
  id: string;
  parentSpanId: string | null;
  kind: GraphNodeKind;
  status: GraphNodeStatus;
  /** 主标题（span name） */
  title: string;
  /** 副标题：http 节点 = method/status；upstream = 渠道·模型 */
  subtitle: string;
  durationMs: number;
  /** 相对 trace 起点的偏移（瀑布/耗时条用） */
  startOffsetMs: number;
  /** upstream：渠道与模型（提升列） */
  channel: string | null;
  model: string | null;
  /** 第几次渠道尝试（channel.attempt 属性） */
  attempt: number | null;
  /** ERROR 时的 message（status_message） */
  errorText: string | null;
  service: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'child' | 'fallback';
}

export interface TraceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hasError: boolean;
  errorCount: number;
  totalDurationMs: number;
}

function inferKind(row: SpanRow): GraphNodeKind {
  if (row.name.startsWith('upstream')) return 'upstream';
  if (
    'http.method' in row.attributes ||
    'http.status_code' in row.attributes ||
    /^[A-Z]+ \//.test(row.name)
  ) {
    return 'http';
  }
  return 'generic';
}

function buildSubtitle(row: SpanRow, kind: GraphNodeKind): string {
  if (kind === 'http') {
    const method = row.attributes['http.method'];
    const code = row.attributes['http.status_code'];
    return [typeof method === 'string' ? method : null, code != null ? `${code}` : null]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind === 'upstream') {
    return [row.channel, row.model].filter(Boolean).join(' · ');
  }
  return row.service;
}

function inferStatus(row: SpanRow, kind: GraphNodeKind): GraphNodeStatus {
  if (row.statusCode === 2) return 'error';
  if (row.statusCode === 1) return 'ok';
  // OTel 惯例：成功 span 常不设 status（UNSET）；http 节点用状态码兜底推断
  if (kind === 'http') {
    const code = row.attributes['http.status_code'];
    if (typeof code === 'number') return code >= 400 ? 'error' : 'ok';
  }
  return 'unset';
}

export function buildTraceGraph(spans: SpanRow[]): TraceGraph {
  if (spans.length === 0) {
    return { nodes: [], edges: [], hasError: false, errorCount: 0, totalDurationMs: 0 };
  }
  const startMs = Math.min(...spans.map((s) => s.startTime.getTime()));
  const endMs = Math.max(...spans.map((s) => s.endTime.getTime()));

  const sorted = spans.toSorted((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const nodes: GraphNode[] = sorted.map((row) => {
    const kind = inferKind(row);
    const attemptRaw = row.attributes['channel.attempt'];
    return {
      id: row.spanId,
      parentSpanId: row.parentSpanId,
      kind,
      status: inferStatus(row, kind),
      title: row.name,
      subtitle: buildSubtitle(row, kind),
      durationMs: row.durationMs,
      startOffsetMs: row.startTime.getTime() - startMs,
      channel: row.channel,
      model: row.model,
      attempt: typeof attemptRaw === 'number' ? attemptRaw : null,
      errorText: row.statusMessage,
      service: row.service,
    };
  });

  // 按父分组；组内 >1 视为尝试链：首节点接父，其余链式 fallback
  const byParent = new Map<string, SpanRow[]>();
  for (const row of sorted) {
    const key = row.parentSpanId ?? '__root__';
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const edges: GraphEdge[] = [];
  for (const [parentKey, children] of byParent) {
    if (parentKey === '__root__') {
      // 根层多个孤立 trace 碎片（跨服务未串联）不出边，仅出节点
      continue;
    }
    if (children.length === 1) {
      edges.push({ id: `${parentKey}->${children[0]!.spanId}`, from: parentKey, to: children[0]!.spanId, kind: 'child' });
      continue;
    }
    edges.push({ id: `${parentKey}->${children[0]!.spanId}`, from: parentKey, to: children[0]!.spanId, kind: 'child' });
    for (let i = 1; i < children.length; i++) {
      edges.push({
        id: `${children[i - 1]!.spanId}->${children[i]!.spanId}`,
        from: children[i - 1]!.spanId,
        to: children[i]!.spanId,
        kind: 'fallback',
      });
    }
  }

  const errorCount = nodes.filter((n) => n.status === 'error').length;
  return {
    nodes,
    edges,
    hasError: errorCount > 0,
    errorCount,
    totalDurationMs: endMs - startMs,
  };
}
