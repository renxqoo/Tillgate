import type { SpanRow } from './types';

/**
 * spans → 路线图视图模型(纯函数,零展示层依赖)。
 *
 * 展示层(React Flow 等)只做渲染,语义判定全部在这里:
 *   - 节点 kind:http(根/带 http 属性)/ upstream(渠道调用)/
 *     stream(流中继生命周期:首包→流终止,取消/截断的可追溯载体)/
 *     billing(网关侧计费动作:authorize/finalize)/ settle(worker 结算)/ generic
 *   - 状态:statusCode=2 → error(客户端取消流不是网关错误,不标红)
 *   - 执行线:同父兄弟按开始时间排序,首节点接父(child 边),后续依次连前一个
 *     (next 边)——流程按「第一步→第二步」叙事展开,而非并列铺开;
 *     相邻 upstream 兄弟之间的边是渠道重试(fallback,虚线动画在展示层)
 *
 * 消费方:管理面 trace 详情(admin-api 服务端组装,G8——前端不直依赖本包)。
 */

export type GraphNodeKind = 'http' | 'upstream' | 'stream' | 'billing' | 'settle' | 'generic';
export type GraphNodeStatus = 'ok' | 'error' | 'unset';

export interface GraphNode {
  /** spanId(同时是图节点 id) */
  id: string;
  parentSpanId: string | null;
  kind: GraphNodeKind;
  status: GraphNodeStatus;
  /** 主标题(span name) */
  title: string;
  /** 副标题:http 节点 = method/status;upstream = 渠道·模型 */
  subtitle: string;
  durationMs: number;
  /** 相对 trace 起点的偏移(瀑布/耗时条用) */
  startOffsetMs: number;
  /** upstream:渠道与模型(提升列) */
  channel: string | null;
  model: string | null;
  /** 第几次渠道尝试(channel.attempt 属性) */
  attempt: number | null;
  /** ERROR 时的 message(status_message) */
  errorText: string | null;
  service: string;
  /** 执行序(全 trace 按开始时间排序的 1 基序号,「第N步」徽标用) */
  step: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'child' | 'next' | 'fallback';
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
  if (row.name === 'stream.relay') return 'stream';
  if (row.name === 'billing.settle' || row.service === 'worker') return 'settle';
  if (
    row.name === 'billing.authorize' ||
    row.name === 'billing.finalize' ||
    row.name === 'billing.estimate'
  ) {
    return 'billing';
  }
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
  if (kind === 'stream') {
    // 流终态语义:中断带原因(复核线索),正常终态只报字节
    const terminated = row.attributes['stream.terminated'];
    const bytes = row.attributes['stream.bytes_relayed'];
    return [
      typeof terminated === 'string' ? `已中断 ${terminated}` : null,
      typeof bytes === 'number' ? `${bytes} B` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (kind === 'billing' || kind === 'settle') {
    // 计费节点副标题带核心数字:预授权/实扣金额(元)或 token 汇总;
    // 估算节点(billing.estimate / estimated 收尾)显式标注非真实获取
    const estimated = row.attributes['usage.estimated'] === true ? '估算 · ' : '';
    // 释放型收尾(billing.finalize: failed/released):直接回答「扣没扣钱」
    const amountReleased = row.attributes['billing.amount_released'];
    if (typeof amountReleased === 'string' && amountReleased !== '') {
      return `已释放 ${amountReleased} 元 · 未扣费`;
    }
    const amount = row.attributes['billing.amount'] ?? row.attributes['billing.amount_reserved'];
    if (typeof amount === 'string' && amount !== '') {
      const label = kind === 'settle' ? '实扣' : '预授权';
      return `${estimated}${label} ${amount} 元`;
    }
    const input = row.attributes['usage.input_tokens'];
    const output = row.attributes['usage.output_tokens'];
    if (typeof input === 'number' || typeof output === 'number') {
      return `${estimated}tokens ${input ?? 0}→${output ?? 0}`;
    }
    return row.service;
  }
  return row.service;
}

function inferStatus(row: SpanRow, kind: GraphNodeKind): GraphNodeStatus {
  if (row.statusCode === 2) return 'error';
  if (row.statusCode === 1) return 'ok';
  // OTel 惯例:成功 span 常不设 status(UNSET);http 节点用状态码兜底推断
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
  const nodes: GraphNode[] = sorted.map((row, index) => {
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
      step: index + 1,
    };
  });

  // 按父分组(保持开始时间序);执行线:首节点接父,后续依次连前一个。
  // 相邻 upstream 兄弟 = 渠道重试(fallback);其余相邻兄弟 = 时序推进(next)。
  const byParent = new Map<string, SpanRow[]>();
  for (const row of sorted) {
    const key = row.parentSpanId ?? '__root__';
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const edges: GraphEdge[] = [];
  // 节点键集合:悬挂 parent(指向缺失 span)不出边——否则展示层收到 from=不存在节点的边
  const nodeKeys = new Set(sorted.map((row) => row.spanId));
  for (const [parentKey, children] of byParent) {
    if (parentKey === '__root__') {
      // 根层多个孤立 trace 碎片(跨服务未串联)不出边,仅出节点
      continue;
    }
    if (!nodeKeys.has(parentKey)) continue; // 悬挂 parent:子照常出节点,边丢弃
    edges.push(childEdge(parentKey, children[0]!.spanId));
    for (let i = 1; i < children.length; i++) {
      const prev = children[i - 1]!;
      const cur = children[i]!;
      edges.push({
        id: `${prev.spanId}->${cur.spanId}`,
        from: prev.spanId,
        to: cur.spanId,
        kind: inferKind(prev) === 'upstream' && inferKind(cur) === 'upstream' ? 'fallback' : 'next',
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
