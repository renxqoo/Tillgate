/**
 * 链路图展示投影（v1 graph-adapter + tracing/graph buildTraceGraph 合并重写）。
 *
 * 输入是 admin-api wire 行（TraceSpanRow，时间为 ISO 字符串）；本文件做展示边界
 * 唯一的时间归一与图推导（节点/边/执行序）。语义与 observability 包
 * src/tracing/graph.ts 的 buildTraceGraph 保持同步（P5 纪律：前端不得直依赖能力包，
 * 展示投影由 app 持有；权威实现无运行时消费者，词表语义漂移由
 * __test__/trace-graph.test.ts 输入输出向量锁步）。
 */
import type { TraceSpanRow } from '@tillgate/api-client';

export type { TraceSpanRow };

export type GraphNodeKind = 'http' | 'upstream' | 'stream' | 'billing' | 'settle' | 'generic';
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
  channel: string | null;
  model: string | null;
  /** 第几次渠道尝试（channel.attempt 属性） */
  attempt: number | null;
  /** ERROR 时的 message（status_message） */
  errorText: string | null;
  service: string;
  /** 执行序（全 trace 按开始时间排序的 1 基序号，「第N步」徽标用） */
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

function inferKind(row: TraceSpanRow): GraphNodeKind {
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

/** 计费/结算节点副标题：预授权/实扣金额（元）或 token 汇总；估算节点显式标注非真实获取 */
function billingSubtitle(row: TraceSpanRow, kind: 'billing' | 'settle'): string {
  // 估算节点（billing.estimate / estimated 收尾）显式标注非真实获取
  const estimated = row.attributes['usage.estimated'] === true ? '估算 · ' : '';
  // 释放型收尾（billing.finalize: failed/released）：直接回答「扣没扣钱」
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

function buildSubtitle(row: TraceSpanRow, kind: GraphNodeKind): string {
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
    // 流终态语义：中断带原因（复核线索），正常终态只报字节
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
    return billingSubtitle(row, kind);
  }
  return row.service;
}

function inferStatus(row: TraceSpanRow, kind: GraphNodeKind): GraphNodeStatus {
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

/** ISO 时间统一走 Date.parse 归一（一次解析，排序/偏移复用数值）。 */
interface TimedSpan {
  row: TraceSpanRow;
  start: number;
  end: number;
}

/** 时间序 span → 图节点（step 为展示序号，startOffsetMs 相对全 trace 起点） */
function toGraphNodes(sorted: TimedSpan[], startMs: number): GraphNode[] {
  return sorted.map(({ row, start }, index) => {
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
      startOffsetMs: start - startMs,
      channel: row.channel,
      model: row.model,
      attempt: typeof attemptRaw === 'number' ? attemptRaw : null,
      errorText: row.statusMessage,
      service: row.service,
      step: index + 1,
    };
  });
}

/**
 * 兄弟执行线构造：
 * 按父分组（保持开始时间序）；执行线：首节点接父，后续依次连前一个。
 * 相邻 upstream 兄弟 = 渠道重试（fallback）；其余相邻兄弟 = 时序推进（next）。
 * 悬挂 parent（指向缺失 span）不出边——否则展示层收到 from=不存在节点的边；
 * 根层多个孤立 trace 碎片（跨服务未串联）不出边，仅出节点。
 */
function buildSiblingEdges(sorted: TimedSpan[]): GraphEdge[] {
  const byParent = new Map<string, TimedSpan[]>();
  for (const t of sorted) {
    const key = t.row.parentSpanId ?? '__root__';
    byParent.set(key, [...(byParent.get(key) ?? []), t]);
  }
  const edges: GraphEdge[] = [];
  const nodeKeys = new Set(sorted.map((t) => t.row.spanId));
  for (const [parentKey, children] of byParent) {
    if (parentKey === '__root__') continue;
    if (!nodeKeys.has(parentKey)) continue; // 悬挂 parent：子照常出节点，边丢弃
    const [first] = children;
    if (first === undefined) continue; // 分组按推入构造，恒非空——防御不可达路径
    edges.push(childEdge(parentKey, first.row.spanId));
    let prev = first;
    for (const cur of children.slice(1)) {
      edges.push({
        id: `${prev.row.spanId}->${cur.row.spanId}`,
        from: prev.row.spanId,
        to: cur.row.spanId,
        kind:
          inferKind(prev.row) === 'upstream' && inferKind(cur.row) === 'upstream'
            ? 'fallback'
            : 'next',
      });
      prev = cur;
    }
  }
  return edges;
}

export function buildTraceGraph(spans: TraceSpanRow[]): TraceGraph {
  if (spans.length === 0) {
    return { nodes: [], edges: [], hasError: false, errorCount: 0, totalDurationMs: 0 };
  }
  const timed: TimedSpan[] = spans.map((row) => ({
    row,
    start: Date.parse(row.startTime),
    end: Date.parse(row.endTime),
  }));
  const startMs = Math.min(...timed.map((t) => t.start));
  const endMs = Math.max(...timed.map((t) => t.end));

  const sorted = timed.toSorted((a, b) => a.start - b.start);
  const nodes = toGraphNodes(sorted, startMs);
  const edges = buildSiblingEdges(sorted);

  const errorCount = nodes.filter((n) => n.status === 'error').length;
  return {
    nodes,
    edges,
    hasError: errorCount > 0,
    errorCount,
    totalDurationMs: endMs - startMs,
  };
}
