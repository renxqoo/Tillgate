import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTraceGraph } from '../graph.js';
import type { SpanRow } from '../types.js';

/**
 * spans → 路线图视图模型（纯函数，与 React/图库解耦——展示层只做渲染）。
 * 不变量：
 *   - 每个 span 恰好一个节点；节点 kind/status/展示字段由语义推断
 *   - 单子节点 → 普通父子边；同一父下的多兄弟（渠道尝试链）→ 首个接父、
 *     其余链式 fallback 边（虚线动画在展示层）
 *   - 孤立 span（无父子关系）也产出节点（不出图会丢信息）
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
  it('单链：http 根 → upstream 成功，普通父子边 + kind 推断 + 展示字段', () => {
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

  it('fallback 链：同父三兄弟（A ❌ → B ❌ → C ✓）→ 首个接父 + 两条 fallback 边', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const a = span({ spanId: 'a'.repeat(16), parentSpanId: root.spanId, name: 'upstream p1', channel: 'ch-a', statusCode: 2, statusMessage: 'rate_limited' });
    const b = span({ spanId: 'b'.repeat(16), parentSpanId: root.spanId, name: 'upstream p2', channel: 'ch-b', statusCode: 2, statusMessage: 'dead_credential' });
    const c = span({ spanId: 'c'.repeat(16), parentSpanId: root.spanId, name: 'upstream p3', channel: 'ch-c' });
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

  it('错误传播：任一 span ERROR → 根节点 hasErrorSummary 标红整条链', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const bad = span({ spanId: 'b'.repeat(16), parentSpanId: root.spanId, name: 'upstream p', statusCode: 2, statusMessage: 'timeout' });
    const graph = buildTraceGraph([root, bad]);
    expect(graph.hasError).toBe(true);
    expect(graph.errorCount).toBe(1);
  });

  it('孤立 span 产节点不丢；未知形状 kind=generic；attempt 序号透传', () => {
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

  it('startOffsetMs 相对 trace 起点，供展示层做耗时条/热力', () => {
    const root = span({ spanId: 'r'.repeat(16) });
    const child = span({ spanId: 'c'.repeat(16), parentSpanId: root.spanId, startTime: new Date(1_700_000_005_000) });
    const graph = buildTraceGraph([root, child]);
    const childNode = graph.nodes.find((n) => n.id === child.spanId)!;
    expect(childNode.startOffsetMs).toBe(5_000);
  });
});
