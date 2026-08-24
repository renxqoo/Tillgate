/**
 * 临时诊断探针（不入默认门禁语义同 trace-probe）：全真装配网关以 otlp 模式把 span
 * 导出到本地抓包服务器——验证「成功 chat 请求的 9 个 span 是否全部经 OTLP 导出、
 * scope 分组与接收端 decode 期望是否一致」。背景：dev 库 08-23 13:36 的三笔成功
 * 请求每条只剩根 span（08-22 及以前完整 9 span），需判定今天代码 otlp 链是否完整。
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  E2E_MODEL,
  E2EKeys,
  e2ePost,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

let world: E2EWorld;
let gw: E2EGateway;
let keys: E2EKeys;
let capture: Server;
let captureUrl = '';
/** 捕获的 OTLP POST：content-type + 解析后的 body */
const posts: Array<{ contentType: string; body: any }> = [];

beforeAll(async () => {
  capture = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      posts.push({
        contentType: req.headers['content-type'] ?? '',
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(202);
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const port = (capture.address() as { port: number }).port;
  captureUrl = `http://127.0.0.1:${port}`;

  world = await setupE2EWorld();
  gw = await startE2EGateway(world, {
    OTEL_TRACES_MODE: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: captureUrl,
    OTEL_METRICS_INTERVAL_MS: '60000',
  });
  keys = new E2EKeys(world, gw.assembly.billingFacade);
});

afterAll(async () => {
  await gw.stop(); // 装配 shutdown 会 flush span
  await world.teardown();
  await new Promise<void>((resolve) => capture.close(() => resolve()));
});

/** 从捕获的 OTLP bodies 里平铺出全部 span（traceId/name/scope/attrs） */
function allSpans(): Array<{ traceId: string; name: string; scope: string; requestId: unknown }> {
  const out: Array<{ traceId: string; name: string; scope: string; requestId: unknown }> = [];
  for (const p of posts) {
    for (const rs of p.body?.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        const scope = ss.scope?.name ?? '(unset)';
        for (const s of ss.spans ?? []) {
          out.push({
            traceId: s.traceId,
            name: s.name,
            scope,
            requestId: (s.attributes ?? []).find((a: any) => a.key === 'request.id')?.value
              ?.stringValue,
          });
        }
      }
    }
  }
  return out;
}

describe('otlp 导出完整性探针（全真装配 + mock 上游）', () => {
  it('成功 chat 请求：9 个 span 应全部经 OTLP 导出', async () => {
    const { raw } = await keys.issue('100');
    const res = await e2ePost(gw.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id')!;
    console.log(`HTTP ${res.status} x-request-id=${requestId}`);
    await res.text();

    // BatchSpanProcessor 缺省 5s 批窗；等 8s 再取
    await sleep(8_000);
    const spans = allSpans().filter((s) => s.requestId === requestId);
    const traceIds = new Set(spans.map((s) => s.traceId));
    console.log(
      `捕获 POST=${posts.length} 个（content-type=${[...new Set(posts.map((p) => p.contentType))].join(',')}），` +
        `本请求 span=${spans.length} 个，traceId=${[...traceIds].join(',')}`,
    );
    for (const s of spans) console.log(`  [${s.scope}] ${s.name}`);
    expect(spans.map((s) => s.name).sort()).toEqual(
      [
        'POST /v1/chat/completions',
        'auth.api_key',
        'rate_limit.admit',
        'inference.prepare',
        'billing.authorize',
        'routing.resolve',
        'billing.reserve_channel',
        'upstream.attempt',
        'billing.settle_signal',
      ].sort(),
    );
    expect(traceIds.size).toBe(1);
  });
});
