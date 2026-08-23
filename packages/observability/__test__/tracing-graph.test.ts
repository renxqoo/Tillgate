import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTraceGraph } from '../src/tracing/graph';
import type { SpanRow } from '../src/tracing/types';

/**
 * spans → 路线图视图模型(纯函数,与 React/图库解耦——展示层只做渲染)。
 * v1 packages/tracing graph.test.ts 平移(MIGRATION §1.5);陈旧措辞随迁修正。
 * 不变量:
 *   - 每个 span 恰好一个节点;节点 kind/status/展示字段由语义推断
 *   - 单子节点 → 普通父子边;同一父下的多兄弟(渠道尝试链)→ 首个接父、
 *     其余链式 fallback 边(虚线动画在展示层)
 *   - 孤立 span(无父子关系)也产出节点(不出图会丢信息)
 */

function span(overrides: Partial<SpanRow> = {}): SpanRow {
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const start = new Date(1_700_000_000_000);
  return {
    traceId: 'a'.repeat(32),
    spanId,
    parentSpanId: null,
    name: 'POST /v1/chat/completions',
    service: 'gateway',
    startTime: start,
    endTime: new Date(start.getTime() + 100),
    durationMs: 100,
    statusCode: 0,
    statusMessage: null,
    requestId: 'req-1',
    userId: 1,
    channel: null,
    model: null,
    attributes: { 'http.method': 'POST', 'http.status_code': 200 },
    events: [],
    ...overrides,
  };
}

describe('buildTraceGraph', () => {
  it('悬挂 parent(parentSpanId 指向缺失 span):子节点保留,边丢弃(不出 from=不存在节点的边)', () => {
    const orphan = span({ parentSpanId: 'deadbeefdeadbeef', name: 'upstream ghost-parent' });
    const graph = buildTraceGraph([orphan]);
    expect(graph.nodes).toHaveLength(1); // 孤儿子照常出节点(不出图丢信息)
    expect(graph.edges).toHaveLength(0); // 悬挂边不出——展示层不再需要容错缺失 from
  });

  it('单链:http 根 → upstream 成功,普通父子边 + kind 推断 + 展示字段', () => {
    const root = span();
    const ok = span({
      spanId: 'b'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream provider-a',
      channel: 'ch-a',
      model: 'deepseek-chat',
      durationMs: 800,
    });
    const graph = buildTraceGraph([root, ok]);
    expect(graph.nodes).toHaveLength(2);
    const rootNode = graph.nodes.find((n) => n.id === root.spanId)!;
    const upNode = graph.nodes.find((n) => n.id === ok.spanId)!;
    expect(rootNode.kind).toBe('http');
    expect(rootNode.status).toBe('ok');
    expect(rootNode.subtitle).toContain('POST');
    expect(upNode.kind).toBe('upstream');
    expect(upNode.channel).toBe('ch-a');
    expect(upNode.model).toBe('deepseek-chat');
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: root.spanId, to: ok.spanId, kind: 'child' });
  });

  it('fallback 链:同父三兄弟(A ❌ → B ❌ → C ✓)→ 首个接父 + 两条 fallback 边', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const a = span({
      spanId: 'a'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream p1',
      channel: 'ch-a',
      statusCode: 2,
      statusMessage: 'rate_limited',
    });
    const b = span({
      spanId: 'b'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream p2',
      channel: 'ch-b',
      statusCode: 2,
      statusMessage: 'dead_credential',
    });
    const c = span({
      spanId: 'c'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream p3',
      channel: 'ch-c',
    });
    const graph = buildTraceGraph([root, a, b, c]);
    expect(graph.nodes).toHaveLength(4);
    const fallbackEdges = graph.edges.filter((e) => e.kind === 'fallback');
    expect(fallbackEdges).toHaveLength(2);
    expect(fallbackEdges[0]).toMatchObject({ from: a.spanId, to: b.spanId });
    expect(fallbackEdges[1]).toMatchObject({ from: b.spanId, to: c.spanId });
    expect(graph.edges.filter((e) => e.kind === 'child')).toHaveLength(1);
    // 错误节点带 status error + 错误信息
    const aNode = graph.nodes.find((n) => n.id === a.spanId)!;
    expect(aNode.status).toBe('error');
    expect(aNode.errorText).toBe('rate_limited');
  });

  it('错误传播:任一 span ERROR → 整图 hasError,错误节点计数', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const bad = span({
      spanId: 'b'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream p',
      statusCode: 2,
      statusMessage: 'timeout',
    });
    const graph = buildTraceGraph([root, bad]);
    expect(graph.hasError).toBe(true);
    expect(graph.errorCount).toBe(1);
  });

  it('孤立 span 产节点不丢;未知形状 kind=generic;attempt 序号透传', () => {
    const lone = span({
      spanId: 'l'.repeat(16),
      name: 'worker settle',
      attributes: { 'channel.attempt': 2 }, // 非 http 形状
    });
    const graph = buildTraceGraph([lone]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.kind).toBe('generic');
    expect(graph.nodes[0]!.attempt).toBe(2);
    expect(graph.edges).toHaveLength(0);
  });

  it('startOffsetMs 相对 trace 起点,供展示层做耗时条/热力', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const child = span({
      spanId: 'c'.repeat(16),
      parentSpanId: root.spanId,
      startTime: new Date(1_700_000_005_000),
    });
    const graph = buildTraceGraph([root, child]);
    const childNode = graph.nodes.find((n) => n.id === child.spanId)!;
    expect(childNode.startOffsetMs).toBe(5_000);
  });

  // ---- 完整链路形态(预授权 → 上游(含换渠道)→ 收尾/结算)----

  it('根的多类子节点:兄弟按开始时间串成执行线(首接父、后续顺序相连)', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const authorize = span({
      spanId: 'a'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.authorize',
      attributes: { 'billing.result': 'authorized', 'billing.amount_reserved': '2.5' },
    });
    const up1 = span({
      spanId: 'b'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream p1',
      statusCode: 2,
      statusMessage: 'rate_limited',
    });
    const up2 = span({ spanId: 'c'.repeat(16), parentSpanId: root.spanId, name: 'upstream p2' });
    const relay = span({
      spanId: 's'.repeat(16),
      parentSpanId: root.spanId,
      name: 'stream.relay',
      startTime: new Date(1_700_000_001_500),
      attributes: { 'stream.bytes_relayed': 100 },
    });
    const finalize = span({
      spanId: 'd'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.finalize',
      attributes: { 'billing.finalize': 'succeeded', 'usage.input_tokens': 10 },
      startTime: new Date(1_700_000_002_000),
    });
    const graph = buildTraceGraph([root, authorize, up1, up2, relay, finalize]);

    // 执行线:根 → authorize(child)→ up1 → up2(渠道重试=fallback)→ relay → finalize(顺序 next)
    expect(graph.edges).toContainEqual({
      id: `${root.spanId}->${authorize.spanId}`,
      from: root.spanId,
      to: authorize.spanId,
      kind: 'child',
    });
    expect(graph.edges).toContainEqual({
      id: `${authorize.spanId}->${up1.spanId}`,
      from: authorize.spanId,
      to: up1.spanId,
      kind: 'next',
    });
    expect(graph.edges.filter((e) => e.kind === 'fallback')).toEqual([
      { id: `${up1.spanId}->${up2.spanId}`, from: up1.spanId, to: up2.spanId, kind: 'fallback' },
    ]);
    expect(graph.edges).toContainEqual({
      id: `${up2.spanId}->${relay.spanId}`,
      from: up2.spanId,
      to: relay.spanId,
      kind: 'next',
    });
    expect(graph.edges).toContainEqual({
      id: `${relay.spanId}->${finalize.spanId}`,
      from: relay.spanId,
      to: finalize.spanId,
      kind: 'next',
    });
    expect(graph.edges).toHaveLength(5);

    // 步骤号:全 trace 按开始时间的执行序(根=1,authorize=2 …)
    const stepOf = (id: string) => graph.nodes.find((n) => n.id === id)!.step;
    expect(stepOf(root.spanId)).toBe(1);
    expect(stepOf(authorize.spanId)).toBe(2);
    expect(stepOf(up1.spanId)).toBe(3);
    expect(stepOf(up2.spanId)).toBe(4);
    expect(stepOf(relay.spanId)).toBe(5);
    expect(stepOf(finalize.spanId)).toBe(6);
  });

  it('billing 节点 kind/subtitle:预授权显示金额,finalize 显示 usage 汇总', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const authorize = span({
      spanId: 'a'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.authorize',
      attributes: { 'billing.result': 'authorized', 'billing.amount_reserved': '2.5' },
    });
    const finalize = span({
      spanId: 'd'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.finalize',
      attributes: {
        'billing.finalize': 'succeeded',
        'usage.input_tokens': 1000,
        'usage.output_tokens': 200,
      },
    });
    const graph = buildTraceGraph([root, authorize, finalize]);
    const authNode = graph.nodes.find((n) => n.id === authorize.spanId)!;
    expect(authNode.kind).toBe('billing');
    expect(authNode.subtitle).toContain('2.5');
    const finNode = graph.nodes.find((n) => n.id === finalize.spanId)!;
    expect(finNode.kind).toBe('billing');
    expect(finNode.subtitle).toContain('1000');
  });

  it('释放型收尾节点:subtitle 显示释放金额与未扣费,状态标红可定位错步', () => {
    const root = span({
      attributes: { 'http.method': 'POST', 'http.status_code': 402 },
      statusCode: 2,
    });
    const upstream = span({
      spanId: 'u'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream minimax',
      startTime: new Date(1_700_000_001_000),
      statusCode: 2,
      statusMessage: 'insufficient_balance_error',
      attributes: { 'http.status_code': 402, 'upstream.error_code': 'insufficient_balance_error' },
    });
    const finalize = span({
      spanId: 'f'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.finalize',
      startTime: new Date(1_700_000_002_000),
      statusCode: 2,
      statusMessage: 'insufficient_balance_error',
      attributes: {
        'billing.finalize': 'failed',
        'billing.failure_reason': 'insufficient_balance_error',
        'billing.state': 'released',
        'billing.amount_released': '0.6751185',
      },
    });
    const graph = buildTraceGraph([root, upstream, finalize]);
    const upNode = graph.nodes.find((n) => n.id === upstream.spanId)!;
    expect(upNode.status).toBe('error');
    expect(upNode.errorText).toBe('insufficient_balance_error');
    const finNode = graph.nodes.find((n) => n.id === finalize.spanId)!;
    expect(finNode.status).toBe('error');
    expect(finNode.subtitle).toBe('已释放 0.6751185 元 · 未扣费');
  });

  it('worker 结算 span:kind=settle,subtitle 显示实扣金额', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const settle = span({
      spanId: 's'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.settle',
      service: 'worker',
      attributes: { 'billing.state': 'settled', 'billing.amount': '1.8' },
      startTime: new Date(1_700_000_003_000),
    });
    const graph = buildTraceGraph([root, settle]);
    const node = graph.nodes.find((n) => n.id === settle.spanId)!;
    expect(node.kind).toBe('settle');
    expect(node.subtitle).toContain('1.8');
    expect(graph.edges).toContainEqual({
      id: `${root.spanId}->${settle.spanId}`,
      from: root.spanId,
      to: settle.spanId,
      kind: 'child',
    });
  });

  it('billing.estimate:kind=billing,副标题标注估算与 token(非真实获取)', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const estimate = span({
      spanId: 'e'.repeat(16),
      parentSpanId: root.spanId,
      name: 'billing.estimate',
      startTime: new Date(1_700_000_001_800),
      attributes: {
        'usage.estimated': true,
        'estimate.reason': 'client_disconnect',
        'estimate.bytes_relayed': 6273,
        'usage.input_tokens': 2000,
        'usage.output_tokens': 188,
      },
    });
    const graph = buildTraceGraph([root, estimate]);
    const node = graph.nodes.find((n) => n.id === estimate.spanId)!;
    expect(node.kind).toBe('billing');
    expect(node.subtitle).toContain('估算');
    expect(node.subtitle).toContain('188');
  });

  // ---- stream.relay:流生命周期节点(取消/截断的可追溯载体)----

  it('stream.relay 中断:kind=stream,subtitle 带终止原因与字节,串在 upstream 之后(next 边)', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const up = span({
      spanId: 'b'.repeat(16),
      parentSpanId: root.spanId,
      name: 'upstream p1',
      channel: 'ch-a',
    });
    const relay = span({
      spanId: 's'.repeat(16),
      parentSpanId: root.spanId,
      name: 'stream.relay',
      startTime: new Date(1_700_000_000_500),
      endTime: new Date(1_700_000_009_500),
      durationMs: 9000,
      attributes: {
        'stream.terminated': 'client_disconnect',
        'stream.bytes_relayed': 123,
        'stream.duration_ms': 9000,
      },
    });
    const graph = buildTraceGraph([root, up, relay]);
    const relayNode = graph.nodes.find((n) => n.id === relay.spanId)!;
    expect(relayNode.kind).toBe('stream');
    expect(relayNode.subtitle).toContain('client_disconnect');
    expect(relayNode.subtitle).toContain('123');
    // 客户端取消不是网关错误:不计入 error(statusCode=2 才是 error)
    expect(relayNode.status).toBe('unset');
    expect(graph.hasError).toBe(false);
    // 执行线:root → upstream(child)→ stream.relay(next),绝不出 fallback
    expect(graph.edges).toContainEqual({
      id: `${root.spanId}->${up.spanId}`,
      from: root.spanId,
      to: up.spanId,
      kind: 'child',
    });
    expect(graph.edges).toContainEqual({
      id: `${up.spanId}->${relay.spanId}`,
      from: up.spanId,
      to: relay.spanId,
      kind: 'next',
    });
    expect(graph.edges.filter((e) => e.kind === 'fallback')).toHaveLength(0);
  });

  it('stream.relay 正常终态:subtitle 显示透传字节,无终止原因', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const relay = span({
      spanId: 's'.repeat(16),
      parentSpanId: root.spanId,
      name: 'stream.relay',
      attributes: {
        'stream.ttfb_ms': 120,
        'stream.bytes_relayed': 2048,
        'stream.duration_ms': 5000,
        'usage.input_tokens': 10,
        'usage.output_tokens': 5,
      },
    });
    const graph = buildTraceGraph([root, relay]);
    const relayNode = graph.nodes.find((n) => n.id === relay.spanId)!;
    expect(relayNode.kind).toBe('stream');
    expect(relayNode.subtitle).toContain('2048');
    expect(relayNode.subtitle).not.toContain('中断');
    expect(relayNode.status).toBe('unset');
  });

  it('空集:零节点零边零错误的空图', () => {
    expect(buildTraceGraph([])).toEqual({
      nodes: [],
      edges: [],
      hasError: false,
      errorCount: 0,
      totalDurationMs: 0,
    });
  });
});
