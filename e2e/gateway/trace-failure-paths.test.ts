/**
 * 临时诊断探针（同 trace-probe 装置）：失败路径的 span 树——
 * ① 流式 + 上游不可达（连接拒绝 → 单渠道耗尽 → billing.release_and_fail）
 * ② 非流式 + 上游 400 拒绝（→ billing.passthrough_4xx 透传）
 * ③ 流式 + 用户取消（mid-stream abort → 终态结算 streamAborted）
 * memory 模式只在 span **结束**后快照——某 span 永不结束（泄漏）会直接表现为树里缺失。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initOtel, type MemoryTraceViewer, type ViewableTrace } from '@tillgate/observability';
import {
  defined,
  E2E_MODEL,
  E2EKeys,
  e2ePost,
  retargetUpstream,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

let otel: ReturnType<typeof initOtel>;
let memory: MemoryTraceViewer;
let world: E2EWorld;
let gw: E2EGateway;
let keys: E2EKeys;
let upstreamUrl: string;

beforeAll(async () => {
  otel = initOtel({ serviceName: 'gateway', serviceVersion: 'probe', mode: 'memory' });
  memory = defined(otel.memory, 'otel.memory');
  world = await setupE2EWorld();
  upstreamUrl = world.upstream.url;
  gw = await startE2EGateway(world);
  keys = new E2EKeys(world, gw.assembly.billingFacade);
});

afterAll(async () => {
  await gw.stop();
  await world.teardown();
  await otel.shutdown();
});

/** 等该请求的 trace 落缓冲；要求出现终局 span（settle/release/passthrough）才算齐 */
async function waitTrace(
  requestId: string,
  terminal: string[],
  deadlineMs = 15_000,
): Promise<ViewableTrace> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hit = memory
      .recent(50)
      .find((t) => t.spans.some((s) => s.attributes['request.id'] === requestId));
    if (hit && terminal.every((n) => hit.spans.some((s) => s.name === n))) return hit;
    if (Date.now() > deadline) {
      if (hit) return hit; // 超时也返回已有部分，让断言/打印暴露缺什么
      throw new Error(`no trace for ${requestId}`);
    }
    await sleep(150);
  }
}

function dump(trace: ViewableTrace, label: string): void {
  const root = trace.spans.reduce((a, b) => (a.startTimeMs <= b.startTimeMs ? a : b));
  const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
  console.log(
    `\n===== [${label}] root="${trace.rootName}" spans=${trace.spanCount} hasError=${trace.hasError} dur=${trace.durationMs.toFixed(1)}ms =====`,
  );
  for (const s of trace.spans.toSorted((a, b) => a.startTimeMs - b.startTimeMs)) {
    const parent = byId.get(s.parentSpanId);
    console.log(
      `  ${s.name.padEnd(26)} dur=${s.durationMs.toFixed(1).padStart(7)}ms  +${(s.startTimeMs - root.startTimeMs).toFixed(1).padStart(6)}→${(s.endTimeMs - root.startTimeMs).toFixed(1).padStart(7)}ms  ${s.status.code === 2 ? `ERROR(${s.status.message ?? ''})` : 'OK'}  parent=${parent?.name ?? '-'}  ${JSON.stringify(s.attributes)}`,
    );
  }
}

/** trace 分组转储形状（③ 全缓冲转储——诊断打印用；提模块级避免回调深嵌套） */
const traceGroupDump = (t: ViewableTrace): Record<string, unknown> => ({
  traceId: t.traceId,
  root: t.rootName,
  n: t.spanCount,
  names: t.spans.map((s) => s.name),
});

/** 判 trace 是否含该请求的 span（③ 同一请求应单分组断言用） */
function traceContainsRequest(t: ViewableTrace, requestId: string): boolean {
  return t.spans.some((s) => s.attributes['request.id'] === requestId);
}

describe('失败路径 span 树（全真装配 + mock 上游）', () => {
  it('① 流式 + 上游不可达：upstream.attempt ERROR + billing.release_and_fail，客户端 5xx', async () => {
    await retargetUpstream(world, {
      baseUrl: 'http://127.0.0.1:9',
      apiKeyPlain: 'sk-x',
      protocol: 'openai-compatible',
    });
    const { raw } = await keys.issue('100');
    memory.clear();
    const res = await e2ePost(gw.baseUrl, raw, {
      model: E2E_MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    const body = await res.text();
    console.log(`HTTP ${res.status} x-request-id=${requestId} body=${body.slice(0, 120)}`);
    const trace = await waitTrace(requestId, ['billing.release_and_fail']);
    dump(trace, '流式·上游不可达');
    const names = trace.spans.map((s) => s.name);
    expect(names).toContain('billing.release_and_fail');
    expect(names).not.toContain('billing.settle_signal'); // 无收据不结算
    const attempt = defined(
      trace.spans.find((s) => s.name === 'upstream.attempt'),
      'upstream.attempt span',
    );
    expect(attempt.attributes['upstream.ok']).toBe(false);
    expect(trace.hasError).toBe(true);
  });

  it('② 非流式 + 上游 400：billing.passthrough_4xx，客户端 4xx 透传', async () => {
    await retargetUpstream(world, {
      baseUrl: upstreamUrl,
      apiKeyPlain: 'sk-e2e-minimax-0123456789abcdef',
      protocol: 'openai-compatible',
    });
    world.upstream.script = 'nonstream-reject';
    const { raw } = await keys.issue('100');
    memory.clear();
    const res = await e2ePost(gw.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: 'x' }],
    });
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    const body = await res.text();
    console.log(`HTTP ${res.status} x-request-id=${requestId} body=${body.slice(0, 120)}`);
    const trace = await waitTrace(requestId, ['billing.passthrough_4xx']);
    dump(trace, '非流式·上游400');
    expect(trace.spans.map((s) => s.name)).toContain('billing.passthrough_4xx');
  });

  // 2026-08-24 探针发现的取消孤儿缺陷已根治：终态结算经 TracePort.captureRoot()
  // 挂请求根上下文并计入根生命周期——取消路径的 billing.settle_signal 与主链同
  // traceId、挂根 span，一条请求一棵树（不再断成主链 + 孤儿 settle 两条 trace）。
  it('③ 流式 + 用户取消：mid-stream abort → 仍有终态结算 span，树完整落缓冲', async () => {
    world.upstream.script = 'auto';
    world.upstream.frameGapMs = 30; // 帧间留空隙，确保能在流中途 abort
    const { raw } = await keys.issue('100');
    memory.clear();
    const controller = new AbortController();
    const res = await e2ePost(
      gw.baseUrl,
      raw,
      { model: E2E_MODEL, stream: true, messages: [{ role: 'user', content: '讲故事' }] },
      controller.signal,
    );
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    // 读到第一帧后取消
    const reader = defined(res.body, 'stream body').getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    console.log(`流式已取消 x-request-id=${requestId}`);
    const trace = await waitTrace(requestId, ['billing.settle_signal']);
    dump(trace, '流式·用户取消');
    // 全缓冲转储：确认其余 span 是「未结束」还是「落在了别的 traceId 分组」
    console.log('memory 全部 trace 分组:', JSON.stringify(memory.recent(50).map(traceGroupDump)));
    const names = trace.spans.map((s) => s.name);
    expect(names).toContain('billing.settle_signal'); // 取消也要结算（估算/实收）
    // 正确形状：单 traceId —— settle 与主链同一条 trace，不是孤儿
    const groups = memory.recent(50).filter((t) => traceContainsRequest(t, requestId));
    expect(groups, '同一请求的 span 应落在同一个 traceId 分组').toHaveLength(1);
    const root = trace.spans.find((s) => s.name === 'POST /v1/chat/completions');
    expect(root).toBeDefined();
    const settle = defined(
      trace.spans.find((s) => s.name === 'billing.settle_signal'),
      'settle span',
    );
    expect(settle.traceId).toBe(defined(root, 'root span').traceId);
  });
});
