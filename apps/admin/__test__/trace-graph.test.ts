/**
 * 链路图投影纯函数测试：与 observability 包 buildTraceGraph 语义锁步
 * （同输入同输出向量；展示副本漂移在此暴露）。
 */
import { describe, expect, it } from 'vitest';

import { buildTraceGraph, type TraceSpanRow } from '../src/features/tracing/graph';

function span(partial: Partial<TraceSpanRow> & { spanId: string; name: string }): TraceSpanRow {
  return {
    traceId: 't',
    parentSpanId: null,
    service: 'gateway',
    startTime: '2026-08-23T00:00:00.000Z',
    endTime: '2026-08-23T00:00:01.000Z',
    durationMs: 1000,
    statusCode: 1,
    statusMessage: null,
    requestId: null,
    userId: null,
    channel: null,
    model: null,
    attributes: {},
    events: [],
    ...partial,
  };
}

describe('buildTraceGraph', () => {
  it('空 spans → 空图', () => {
    expect(buildTraceGraph([])).toEqual({
      nodes: [],
      edges: [],
      hasError: false,
      errorCount: 0,
      totalDurationMs: 0,
    });
  });

  it('父子边 + 执行序 + 时间偏移（ISO 字符串归一）', () => {
    const g = buildTraceGraph([
      span({
        spanId: 'root',
        name: 'POST /v1/chat',
        attributes: { 'http.method': 'POST', 'http.status_code': 200 },
      }),
      span({
        spanId: 'child',
        name: 'upstream.call',
        parentSpanId: 'root',
        channel: 'c1',
        model: 'm1',
        startTime: '2026-08-23T00:00:00.100Z',
        endTime: '2026-08-23T00:00:00.600Z',
        durationMs: 500,
      }),
    ]);
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.map((n) => n.step)).toEqual([1, 2]);
    expect(g.nodes[1]).toMatchObject({ kind: 'upstream', subtitle: 'c1 · m1', startOffsetMs: 100 });
    expect(g.nodes[0]).toMatchObject({ kind: 'http', subtitle: 'POST · 200', status: 'ok' });
    expect(g.edges).toEqual([{ id: 'root->child', from: 'root', to: 'child', kind: 'child' }]);
    expect(g.totalDurationMs).toBe(1000);
    expect(g.hasError).toBe(false);
  });

  it('相邻 upstream 兄弟 = fallback（渠道重试线）；ERROR 状态计数', () => {
    const g = buildTraceGraph([
      span({ spanId: 'r', name: 'POST /' }),
      span({
        spanId: 'u1',
        name: 'upstream.try',
        parentSpanId: 'r',
        statusCode: 2,
        statusMessage: 'boom',
      }),
      span({
        spanId: 'u2',
        name: 'upstream.try',
        parentSpanId: 'r',
        startTime: '2026-08-23T00:00:00.200Z',
      }),
    ]);
    expect(g.errorCount).toBe(1);
    expect(g.hasError).toBe(true);
    const kinds = g.edges.map((e) => e.kind);
    expect(kinds).toContain('child');
    expect(kinds).toContain('fallback');
    expect(g.nodes.find((n) => n.id === 'u1')?.errorText).toBe('boom');
  });

  it('悬挂 parent：子出节点、边丢弃（展示层不收幽灵边）', () => {
    const g = buildTraceGraph([
      span({ spanId: 'a', name: 'x' }),
      span({ spanId: 'b', name: 'y', parentSpanId: 'missing' }),
    ]);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([]);
  });

  it('计费节点副标题：预授权/实扣金额与估算标注（中文展示语义锁步）', () => {
    const g = buildTraceGraph([
      span({
        spanId: 'ba',
        name: 'billing.authorize',
        service: 'billing',
        attributes: { 'billing.amount_reserved': '0.42' },
      }),
      span({
        spanId: 'be',
        name: 'billing.estimate',
        service: 'billing',
        startTime: '2026-08-23T00:00:00.001Z',
        attributes: { 'usage.estimated': true, 'usage.input_tokens': 10, 'usage.output_tokens': 5 },
      }),
      span({
        spanId: 'bf',
        name: 'billing.finalize',
        service: 'billing',
        startTime: '2026-08-23T00:00:00.002Z',
        attributes: { 'billing.amount_released': '0.42' },
      }),
    ]);
    expect(g.nodes.find((n) => n.id === 'ba')?.subtitle).toBe('预授权 0.42 元');
    expect(g.nodes.find((n) => n.id === 'be')?.subtitle).toBe('估算 · tokens 10→5');
    expect(g.nodes.find((n) => n.id === 'bf')?.subtitle).toBe('已释放 0.42 元 · 未扣费');
  });

  it('同输入确定性：两次构建全等（dagre 布局上游依赖）', () => {
    const spans = [
      span({ spanId: 'a', name: 'POST /' }),
      span({ spanId: 'b', name: 'upstream.x', parentSpanId: 'a' }),
    ];
    expect(buildTraceGraph(spans)).toEqual(buildTraceGraph(spans));
  });
});
