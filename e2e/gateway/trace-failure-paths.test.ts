/**
 * 临时诊断探针（同 trace-probe 装置）：失败路径的 span 树——
 * ① 流式 + 上游不可达（连接拒绝 → 单渠道耗尽 → billing.release_and_fail）
 * ② 非流式 + 上游 400 拒绝（→ billing.passthrough_4xx 透传）
 * ③ 流式 + 用户取消（mid-stream abort → 终态结算 streamAborted）
 * memory 模式只在 span **结束**后快照——某 span 永不结束（泄漏）会直接表现为树里缺失。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initOtel, type MemoryTraceViewer, type ViewableTrace } from '@tokenlens/observability';
import {
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
  memory = otel.memory!;
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
    const requestId = res.headers.get('x-request-id')!;
    const body = await res.text();
    console.log(`HTTP ${res.status} x-request-id=${requestId} body=${body.slice(0, 120)}`);
    const trace = await waitTrace(requestId, ['billing.release_and_fail']);
    dump(trace, '流式·上游不可达');
    const names = trace.spans.map((s) => s.name);
    expect(names).toContain('billing.release_and_fail');
    expect(names).not.toContain('billing.settle_signal'); // 无收据不结算
    const attempt = trace.spans.find((s) => s.name === 'upstream.attempt')!;
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
    const requestId = res.headers.get('x-request-id')!;
    const body = await res.text();
    console.log(`HTTP ${res.status} x-request-id=${requestId} body=${body.slice(0, 120)}`);
    const trace = await waitTrace(requestId, ['billing.passthrough_4xx']);
    dump(trace, '非流式·上游400');
    expect(trace.spans.map((s) => s.name)).toContain('billing.passthrough_4xx');
  });

  // 已知缺陷（2026-08-24 探针发现，it.fails 锁存）：流式中途取消时终态结算回调
  // （stream.ts `void settle(event)` fire-and-forget）运行在丢失请求 span 上下文的
  // 异步链里——billing.settle_signal 拿到全新 traceId、无父无根，一条请求断成两条
  // trace（主链 8 span + 孤儿 settle）。正常完成路径 settle 同 traceId（挂已结束的
  // upstream.attempt 下、时窗逃逸根 span——见 trace-probe.test.ts 流式用例）。
  it.fails('③ 流式 + 用户取消：mid-stream abort → 仍有终态结算 span，树完整落缓冲', async () => {
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
    const requestId = res.headers.get('x-request-id')!;
    // 读到第一帧后取消
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    console.log(`流式已取消 x-request-id=${requestId}`);
    const trace = await waitTrace(requestId, ['billing.settle_signal']);
    dump(trace, '流式·用户取消');
    // 全缓冲转储：确认其余 span 是「未结束」还是「落在了别的 traceId 分组」
    console.log(
      'memory 全部 trace 分组:',
      JSON.stringify(
        memory.recent(50).map((t) => ({
          traceId: t.traceId,
          root: t.rootName,
          n: t.spanCount,
          names: t.spans.map((s) => s.name),
        })),
      ),
    );
    const names = trace.spans.map((s) => s.name);
    expect(names).toContain('billing.settle_signal'); // 取消也要结算（估算/实收）
    // 正确形状：单 traceId —— settle 与主链同一条 trace，不是孤儿
    const groups = memory
      .recent(50)
      .filter((t) => t.spans.some((s) => s.attributes['request.id'] === requestId));
    expect(groups, '同一请求的 span 应落在同一个 traceId 分组').toHaveLength(1);
    const root = trace.spans.find((s) => s.name === 'POST /v1/chat/completions');
    expect(root).toBeDefined();
    const settle = trace.spans.find((s) => s.name === 'billing.settle_signal')!;
    expect(settle.traceId).toBe(root!.traceId);
  });
});
