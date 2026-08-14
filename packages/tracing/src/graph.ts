import type { SpanRow } from './types.js';

/**
 * spans → 路线图视图模型（纯函数，零展示层依赖）。
 *
 * 展示层（React Flow 等）只做渲染，语义判定全部在这里：
 *   - 节点 kind：http（根/带 http 属性）/ upstream（渠道调用）/
 *     billing（网关侧计费动作：authorize/finalize）/ settle（worker 结算）/ generic
 *   - 状态：statusCode=2 → error
 *   - 同父的 upstream 兄弟 = 渠道尝试链：首个接父边，其余链式 fallback 边
 *     （网关候选循环成功即停，因此 2 个以上 upstream 兄弟必为换渠道重试）；
 *     其他 kind 的兄弟（billing/settle 等）各自直连父，不串尝试链
 */

export type GraphNodeKind = 'http' | 'upstream' | 'billing' | 'settle' | 'generic';
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
  if (row.name === 'billing.settle' || row.service === 'worker') return 'settle';
  if (row.name === 'billing.authorize' || row.name === 'billing.finalize') return 'billing';
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
  if (kind === 'billing' || kind === 'settle') {
    // 计费节点副标题带核心数字：预授权/实扣金额（元）或 token 汇总
    const amount =
      row.attributes['billing.amount'] ?? row.attributes['billing.amount_reserved'];
    if (typeof amount === 'string' && amount !== '') {
      const label = kind === 'settle' ? '实扣' : '预授权';
      return `${label} ${amount} 元`;
    }
    const input = row.attributes['usage.input_tokens'];
    const output = row.attributes['usage.output_tokens'];
    if (typeof input === 'number' || typeof output === 'number') {
      return `tokens ${input ?? 0}→${output ?? 0}`;
    }
    return row.service;
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

function childEdge(from: string, to: string): GraphEdge {
  return { id: `${from}->${to}`, from, to, kind: 'child' };
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

  // 按父分组；组内 upstream 兄弟 >1 视为尝试链：首节点接父，其余链式 fallback；
  // 其他 kind 的兄弟（billing/settle/…）各自直连父，绝不串进尝试链
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
    const attemptChain = children.filter((row) => inferKind(row) === 'upstream');
    const direct = children.filter((row) => inferKind(row) !== 'upstream');
    for (const row of direct) {
      edges.push(childEdge(parentKey, row.spanId));
    }
    if (attemptChain.length === 0) continue;
    edges.push(childEdge(parentKey, attemptChain[0]!.spanId));
    for (let i = 1; i < attemptChain.length; i++) {
      edges.push({
        id: `${attemptChain[i - 1]!.spanId}->${attemptChain[i]!.spanId}`,
        from: attemptChain[i - 1]!.spanId,
        to: attemptChain[i]!.spanId,
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
