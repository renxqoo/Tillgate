/**
 * 临时诊断探针（不入默认 e2e 门禁——诊断完即处置）：全真装配网关（真 PG/Redis/
 * billing/inference + mock 上游）+ 进程内 memory OTel，发完整 chat 请求后倒出整棵
 * span 树，逐项核对清单（命名/父子/时序/属性/状态）。
 *
 * 运行（依赖闭包同 e2e：从 apps/gateway 起vitest）：
 *   cd apps/gateway && bun --env-file=../../.env x vitest run -c ../../e2e/vitest.config.ts trace-probe
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initOtel, type MemoryTraceViewer, type ViewableTrace } from '@tillgate/observability';
import {
  defined,
  E2E_MODEL,
  E2EKeys,
  e2ePost,
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

beforeAll(async () => {
  // 先挂 memory provider，再起网关：装配 off 模式 initOtel 纯 no-op，不覆盖全局
  otel = initOtel({ serviceName: 'gateway', serviceVersion: 'probe', mode: 'memory' });
  memory = defined(otel.memory, 'otel.memory');
  world = await setupE2EWorld();
  gw = await startE2EGateway(world);
  keys = new E2EKeys(world, gw.assembly.billingFacade);
});

afterAll(async () => {
  await gw.stop();
  await world.teardown();
  await otel.shutdown();
});

/** 等 span 全部落缓冲（响应返回 ≠ 结算信号等尾段 span 已结束） */
async function waitTrace(requestId: string, deadlineMs = 10_000): Promise<ViewableTrace> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const hit = memory
      .recent(50)
      .find((t) => t.spans.some((s) => s.attributes['request.id'] === requestId));
    const settled = hit?.spans.some((s) => s.name === 'billing.settle_signal');
    if (hit && (settled || Date.now() > deadline)) return hit;
    if (Date.now() > deadline) throw new Error(`no trace for request ${requestId}`);
    await sleep(100);
  }
}

function fmtAttrs(attrs: Record<string, unknown>): string {
  const entries = Object.entries(attrs).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return entries.length > 0 ? entries.join(' ') : '(none)';
}

function dumpTrace(trace: ViewableTrace, label: string): void {
  const root = trace.spans.reduce((a, b) => (a.startTimeMs <= b.startTimeMs ? a : b));
  const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
  console.log(
    `\n===== [${label}] trace ${trace.traceId} root="${trace.rootName}" spans=${trace.spanCount} hasError=${trace.hasError} dur=${trace.durationMs.toFixed(1)}ms =====`,
  );
  const rows = trace.spans.toSorted((a, b) => a.startTimeMs - b.startTimeMs);
  for (const s of rows) {
    const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    console.log(
      `[${String(rows.indexOf(s)).padStart(2)}] ${s.name.padEnd(28)} dur=${s.durationMs.toFixed(1).padStart(8)}ms  +${(s.startTimeMs - root.startTimeMs).toFixed(1).padStart(7)}→${(s.endTimeMs - root.startTimeMs).toFixed(1).padStart(8)}ms  status=${s.status.code === 2 ? `ERROR(${s.status.message ?? ''})` : 'OK'}  parent=${parent ? parent.name : '-'}`,
    );
  }
  for (const s of rows) {
    console.log(`     · ${s.name}: ${fmtAttrs(s.attributes)}`);
    for (const e of s.events) {
      console.log(
        `       event ${e.name} @+${(e.timeMs - root.startTimeMs).toFixed(1)}ms ${e.attributes ? fmtAttrs(e.attributes) : ''}`,
      );
    }
  }
  // 树形视图
  const children = new Map<string | undefined, typeof trace.spans>();
  for (const s of trace.spans) {
    const key = byId.has(s.parentSpanId) ? s.parentSpanId : undefined;
    children.set(key, [...(children.get(key) ?? []), s]);
  }
  const render = (span: (typeof trace.spans)[number], depth: number): void => {
    console.log(`${'  '.repeat(depth)}└ ${span.name} (${span.durationMs.toFixed(1)}ms)`);
    for (const c of (children.get(span.spanId) ?? []).toSorted(
      (a, b) => a.startTimeMs - b.startTimeMs,
    )) {
      render(c, depth + 1);
    }
  };
  console.log('  span tree:');
  for (const r of (children.get(undefined) ?? []).toSorted(
    (a, b) => a.startTimeMs - b.startTimeMs,
  )) {
    render(r, 0);
  }
}

const EXPECTED_STAGES = [
  'auth.api_key',
  'rate_limit.admit',
  'inference.prepare',
  'billing.authorize',
  'routing.resolve',
  'billing.reserve_channel',
  'upstream.attempt',
  'billing.settle_signal',
] as const;

/** 结构核对入参（聚合对象——控制参数个数） */
interface TraceCheckInput {
  trace: ViewableTrace;
  requestId: string;
  httpStatus: number;
  stream: boolean;
}

/** 结构核对：返回违规清单（空 = 全部通过） */
function checkTrace(input: TraceCheckInput): string[] {
  const { trace, requestId, httpStatus, stream } = input;
  const bad: string[] = [];
  const root = trace.spans.find((s) => s.name.startsWith('POST /v1/chat/completions'));
  if (!root) return ['root span POST /v1/chat/completions 缺失'];
  const names = trace.spans.map((s) => s.name);

  if (root.attributes['request.id'] !== requestId) {
    bad.push(`root request.id=${root.attributes['request.id']} != 响应头 ${requestId}`);
  }
  if (root.attributes['http.status_code'] !== httpStatus) {
    bad.push(`root http.status_code=${root.attributes['http.status_code']} != 实际 ${httpStatus}`);
  }
  for (const key of ['user.id', 'api_key.id', 'http.method', 'http.target']) {
    if (!(key in root.attributes)) bad.push(`root 缺属性 ${key}`);
  }
  for (const stage of EXPECTED_STAGES) {
    if (!names.includes(stage)) bad.push(`缺阶段 span ${stage}`);
  }
  // 同一 traceId / 全部挂根 span 下（每请求一棵树，阶段挂根）
  const traceIds = new Set(trace.spans.map((s) => s.traceId));
  if (traceIds.size !== 1) {
    bad.push(`span 跨 ${traceIds.size} 个 traceId：${[...traceIds].join(',')}`);
  }
  for (const s of trace.spans) {
    if (s.spanId === root.spanId) continue;
    if (s.parentSpanId !== root.spanId) bad.push(`${s.name} parent=${s.parentSpanId} 不挂根 span`);
  }
  // 子 span 时间必须落在根 span 窗口内（结算等尾段逃逸 = 时序错误）
  for (const s of trace.spans) {
    if (s.spanId === root.spanId) continue;
    if (s.startTimeMs < root.startTimeMs - 0.5 || s.endTimeMs > root.endTimeMs + 0.5) {
      bad.push(
        `${s.name} 时窗逃逸根 span：+${(s.startTimeMs - root.startTimeMs).toFixed(1)}→+${(s.endTimeMs - root.startTimeMs).toFixed(1)}ms（根 +0→+${(root.endTimeMs - root.startTimeMs).toFixed(1)}ms）`,
      );
    }
  }
  // 阶段先后序（按开始时间）
  const order = EXPECTED_STAGES.map(
    (n) => [n, trace.spans.filter((s) => s.name === n).at(-1)] as const,
  );
  for (let i = 1; i < order.length; i++) {
    const [prevName, prev] = defined(order[i - 1], 'order[i-1]');
    const [curName, cur] = defined(order[i], 'order[i]');
    if (prev && cur && prev.startTimeMs > cur.startTimeMs) {
      bad.push(`时序倒置：${prevName} 开始晚于 ${curName}`);
    }
  }
  const attempt = trace.spans.find((s) => s.name === 'upstream.attempt');
  if (attempt) {
    if (attempt.attributes['upstream.stream'] !== stream) {
      bad.push(
        `upstream.attempt upstream.stream=${attempt.attributes['upstream.stream']} 应为 ${stream}`,
      );
    }
    if (attempt.attributes['upstream.ok'] !== true) {
      bad.push(`upstream.attempt upstream.ok != true`);
    }
    if (stream && typeof attempt.attributes['upstream.ttft_ms'] !== 'number') {
      bad.push('流式 upstream.attempt 缺 upstream.ttft_ms');
    }
    if (!stream && typeof attempt.attributes['upstream.duration_ms'] !== 'number') {
      bad.push('非流式 upstream.attempt 缺 upstream.duration_ms');
    }
  }
  if (trace.hasError) bad.push('成功请求 trace.hasError=true（有 span 标 ERROR）');
  return bad;
}

describe('诊断探针：全真装配完整请求的 span 树', () => {
  it('非流式 chat：完整请求 → 倒出 span 树并核对', async () => {
    // 2026-08-24 诊断结论：非流式全对（9 span 全挂根、时序含结算都在根窗口内）
    const { raw } = await keys.issue('100');
    memory.clear();
    const res = await e2ePost(gw.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: '你好' }],
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log(
      `HTTP ${res.status} x-request-id=${res.headers.get('x-request-id')} choices=${JSON.stringify(body.choices ?? body).slice(0, 80)}`,
    );
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    const trace = await waitTrace(requestId);
    dumpTrace(trace, '非流式 chat');
    const bad = checkTrace({ trace, requestId, httpStatus: res.status, stream: false });
    console.log(
      bad.length === 0
        ? '结构核对：全部通过'
        : `结构核对：${bad.length} 项违规\n  - ${bad.join('\n  - ')}`,
    );
    expect(bad).toEqual([]);
  });

  // 2026-08-24 探针发现的流式缺陷已根治（request-trace 协调器 + 根上下文捕获）：
  // ① billing.settle_signal 经 TracePort.captureRoot() 直挂根 span（不再沿用已结束
  //   的 upstream.attempt 异步上下文）；
  // ② HTTP 根 span 覆盖 SSE 体续传（接力流收口），并在闭合前等后台结算完成——
  //   真实长流下根 span 时长 ≈ 全程，全部子 span 时窗落内。
  it('流式 chat：完整请求 → 倒出 span 树并核对', async () => {
    const { raw } = await keys.issue('100');
    memory.clear();
    const res = await e2ePost(gw.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: '讲个故事' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    // 全量消费 SSE（span 在流终束后结束）
    const text = await res.text();
    const frames = text.split('\n').filter((l) => l.startsWith('data:')).length;
    console.log(`HTTP ${res.status} x-request-id=${requestId} SSE data 帧=${frames}`);
    const trace = await waitTrace(requestId);
    dumpTrace(trace, '流式 chat');
    const bad = checkTrace({ trace, requestId, httpStatus: res.status, stream: true });
    console.log(
      bad.length === 0
        ? '结构核对：全部通过'
        : `结构核对：${bad.length} 项违规\n  - ${bad.join('\n  - ')}`,
    );
    expect(bad).toEqual([]);
  });
});
