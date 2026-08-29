/**
 * 临时诊断探针：零成本闭环「成功请求 → 链路追踪列表」。隔离世界网关（mock 上游，
 * 不碰真实渠道不花钱）以 otlp 模式指向**正在运行的真实 trace-receiver**
 * （http://localhost:8793，写共享 dev 库 trace_spans）——发一笔成功 chat 请求后，
 * 用 admin-api 同款 traces.recent()/byRequest() 查列表，应看到完整 9 span 的 trace。
 * 产物可按 request.id 清理（dev 库只多 9 行诊断 span）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, closeDb } from '@tillgate/db';
import { createObservability } from '@tillgate/observability';
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

const RECEIVER = process.env.TRACE_RECEIVER_URL ?? 'http://localhost:8793';

/** trace 列表行形状（recent/byRequest 断言用） */
interface TraceListRow {
  traceId: string;
  rootName: string;
  spanCount: number;
  hasError: boolean;
}

/** 轮询列表直到该请求出现（批窗 5s + receiver 批量 2s） */
async function waitForListRow(
  traces: ReturnType<typeof createObservability>['traces'],
  requestId: string,
  deadlineMs = 25_000,
): Promise<TraceListRow[]> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    // recent 契约：offset 必填、返回 { rows, total } 信封（见 observability TraceQueries）
    const rows = (await traces.recent({ limit: 30, offset: 0 })).rows.filter(
      (r) => r.requestId === requestId,
    );
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await sleep(1_000);
  }
}

// span 名排序——与默认 sort 同口径（UTF-16 码位比较；unicorn/no-array-sort 要求显式比较器）
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// 本机/CI 没有在跑 receiver 时整组 skip（诊断探针不硬性依赖部署形态）
const receiverUp = await fetch(`${RECEIVER}/readyz`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => r.ok)
  .catch(() => false);

let world: E2EWorld;
let gw: E2EGateway;
let keys: E2EKeys;
let devDb: ReturnType<typeof createDb>;

beforeAll(async () => {
  world = await setupE2EWorld();
  // 隔离世界的网关把 span 导出到真 receiver（off→otlp 覆盖；receiver 写 dev 库）
  gw = await startE2EGateway(world, {
    OTEL_TRACES_MODE: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: RECEIVER,
    OTEL_METRICS_INTERVAL_MS: '60000',
  });
  keys = new E2EKeys(world, gw.assembly.billingFacade);
  // admin-api 同款查询面，连 receiver 写入的共享 dev 库
  devDb = createDb({
    url: defined(process.env.DATABASE_URL, 'DATABASE_URL'),
    poolMax: 8,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 3_000,
  });
});

afterAll(async () => {
  await gw.stop();
  await world.teardown();
  await closeDb(devDb);
});

describe.skipIf(!receiverUp)('成功请求 → 链路追踪列表 闭环（真 receiver + dev 库）', () => {
  it('成功 chat 的 9 span 应出现在 traces.recent / byRequest', async () => {
    const { raw } = await keys.issue('100');
    const res = await e2ePost(gw.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: '闭环测试' }],
    });
    expect(res.status).toBe(200);
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    await res.text();
    console.log(`HTTP 200 x-request-id=${requestId}（隔离世界网关 → 真 receiver ${RECEIVER}）`);

    // 批窗 5s + receiver 批量 2s：轮询列表直到该请求出现（上限 20s）
    const { traces } = createObservability({ db: devDb });
    const deadline = Date.now() + 20_000;
    let row: TraceListRow | undefined;
    for (;;) {
      const { rows: recent } = await traces.recent({ limit: 20, offset: 0 });
      row = recent.find((r) => r.requestId === requestId);
      if (row || Date.now() > deadline) break;
      await sleep(1_000);
    }
    console.log('列表命中:', row ? JSON.stringify(row) : '(未命中)');
    expect(row, 'traces.recent 应包含本请求').toBeDefined();
    const hit = defined(row, 'traces.recent row');
    expect(hit.rootName).toBe('POST /v1/chat/completions');
    expect(hit.spanCount).toBe(9);
    expect(hit.hasError).toBe(false);

    const detail = await traces.byRequest(requestId);
    const names = detail.spans.map((s: { name: string }) => s.name).toSorted(byCodeUnit);
    console.log('byRequest span 名单:', names.join(', '));
    expect(names).toContain('billing.settle_signal');
    expect(names).toContain('upstream.attempt');
  });

  it('失败路径① 上游不可达：列表出现 hasError 的 9-span 记录（release_and_fail）', async () => {
    await retargetUpstream(world, {
      baseUrl: 'http://127.0.0.1:9',
      apiKeyPlain: 'sk-x',
      protocol: 'openai-compatible',
    });
    try {
      const { raw } = await keys.issue('100');
      const res = await e2ePost(gw.baseUrl, raw, {
        model: E2E_MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
      await res.text();
      console.log(`① 上游不可达 HTTP ${res.status} x-request-id=${requestId}`);
      const rows = await waitForListRow(createObservability({ db: devDb }).traces, requestId);
      console.log('① 列表记录:', JSON.stringify(rows));
      expect(rows).toHaveLength(1);
      const firstRow = defined(rows[0], 'rows[0]');
      expect(firstRow.hasError).toBe(true);
      expect(firstRow.spanCount).toBe(9);
    } finally {
      await retargetUpstream(world, {
        baseUrl: world.upstream.url,
        apiKeyPlain: 'sk-e2e-minimax-0123456789abcdef',
        protocol: 'openai-compatible',
      });
    }
  });

  it('失败路径② 上游 400：列表出现 9-span 记录（passthrough_4xx）', async () => {
    world.upstream.script = 'nonstream-reject';
    try {
      const { raw } = await keys.issue('100');
      const res = await e2ePost(gw.baseUrl, raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: 'x' }],
      });
      const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
      await res.text();
      console.log(`② 上游400 HTTP ${res.status} x-request-id=${requestId}`);
      const rows = await waitForListRow(createObservability({ db: devDb }).traces, requestId);
      console.log('② 列表记录:', JSON.stringify(rows));
      expect(rows).toHaveLength(1);
      expect(defined(rows[0], 'rows[0]').spanCount).toBe(9);
    } finally {
      world.upstream.script = 'auto';
    }
  });

  it('失败路径③ 用户取消：列表呈现断链缺陷（主链 8 span + 孤儿 settle）', async () => {
    world.upstream.frameGapMs = 30;
    const { raw } = await keys.issue('100');
    const controller = new AbortController();
    const res = await e2ePost(
      gw.baseUrl,
      raw,
      { model: E2E_MODEL, stream: true, messages: [{ role: 'user', content: '讲故事' }] },
      controller.signal,
    );
    const requestId = defined(res.headers.get('x-request-id'), 'x-request-id');
    const reader = defined(res.body, 'stream body').getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    world.upstream.frameGapMs = 0;
    console.log(`③ 已取消 x-request-id=${requestId}`);
    const rows = await waitForListRow(createObservability({ db: devDb }).traces, requestId);
    console.log(
      '③ 列表记录（缺陷现场：应为两条——8-span 主链 + 1-span 孤儿 settle）:',
      JSON.stringify(rows),
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
