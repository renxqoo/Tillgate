/**
 * 请求级 trace 生命周期单元规格（request-trace 协调器 + trace-port 捕根 +
 * otel 中间件 SSE 接力收口）。全链路 span 树归 trace.test；此处锁三组不变量：
 * 1) coordinator：登记任务 resolve/reject 都算完成；graceTicks 防空集快照
 *    提前放行（取消传播链晚一拍登记仍被等待）；wait 有界（越界即返回不悬挂）。
 * 2) captureRoot：无请求作用域 = detached 直跑；有作用域 = 后台任务在根上下文
 *    运行（span 直挂根）且计入根生命周期。
 * 3) SSE 接力：根 span 在「体送完 ∧ 后台收尾完成」后才闭合（时窗不逃逸）；
 *    客户端取消收口但不置 ERROR；流错误透传并置 ERROR。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  context,
  getTracer,
  initOtel,
  SpanStatusCode,
  trace,
  type ViewableSpan,
} from '@tillgate/observability';
import { RequestTraceCoordinator, requestTraceStorage } from '../src/http/middleware/request-trace';
import { otelMiddleware } from '../src/http/middleware/otel';
import { otelTracePort } from '../src/adapters/trace-port';
import type { AuthEnv } from '../src/http/middleware/api-key';
import { defined } from './defined';

let otel: ReturnType<typeof initOtel>;

beforeAll(() => {
  otel = initOtel({ serviceName: 'gateway', serviceVersion: 'test', mode: 'memory' });
});

afterAll(async () => {
  await otel.shutdown();
});

const tick = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const encode = (s: string) => new TextEncoder().encode(s);

/** 轮询等待条件成立（内存查看器只在 span onEnd 后可见——异步收口必然晚一拍） */
async function until(cond: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met within budget');
    await tick(10);
  }
}

/** 按名取最近已收口的 span（未闭合的 span 不会出现在查看器里） */
function endedSpan(name: string): ViewableSpan | undefined {
  return defined(otel.memory, 'otel.memory')
    .recent()
    .flatMap((t) => t.spans)
    .find((s) => s.name === name);
}

/** 受控门闩：测试决定后台收尾的放行时机（open 在 executor 内同步赋值） */
function createGate(): { gate: Promise<void>; open: () => void } {
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => defined(open, 'createGate().open')() };
}

/** 微任务一拍后登记、tickMs 后完成的收尾任务（复现取消传播链迟到一拍的结算登记） */
function registerLateSettle(
  coordinator: RequestTraceCoordinator,
  tickMs: number,
  onDone: () => void,
): void {
  queueMicrotask(() => {
    coordinator.add(
      (async () => {
        await tick(tickMs);
        onDone();
      })(),
    );
  });
}

/** captureRoot 探针收尾体（模块级可变状态承载探针结果，避免再嵌回调层） */
let probeActiveSpanId = '';
async function probeBackgroundSettle(): Promise<void> {
  // 活动上下文 = 根 span（不沿用已结束的 upstream.attempt——孤儿修复锚点）
  probeActiveSpanId = trace.getSpan(context.active())?.spanContext().spanId ?? '';
  getTracer('gateway').startSpan('bg.capture').end();
}

function sseApp(handler: () => Response) {
  const app = new Hono<AuthEnv>();
  app.use('*', otelMiddleware());
  app.get('/v1/stream', () => handler());
  return app;
}

/** 带门闩收尾的 SSE 装配：体两块后关流，后台结算由 gate 控制放行 */
function gatedSseApp(gate: Promise<void>) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('data: 1\n\n'));
      controller.enqueue(encode('data: 2\n\n'));
      controller.close();
    },
  });
  return sseApp(() => {
    void otelTracePort.captureRoot().runInBackground(async () => {
      await gate; // 模拟流式结算（带重试预算的后台收尾）
      getTracer('gateway').startSpan('bg.settle').end();
    });
    return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
  });
}

describe('RequestTraceCoordinator（后台收尾注册表）', () => {
  it('wait 等待全部登记任务；reject 也算完成不悬挂', async () => {
    const coordinator = new RequestTraceCoordinator();
    let done = false;
    coordinator.add(
      (async () => {
        await tick(15);
        done = true;
      })(),
    );
    // 收尾失败由任务自身上报 onError，协调器只认完成——reject 不得让 wait 悬挂或抛出
    coordinator.add(Promise.reject(new Error('bg failed')));
    await coordinator.wait(2_000, 1);
    expect(done).toBe(true);
  });

  it('wait 有界：任务永不 settle 时按 bound 返回（观测面不阻塞回收）', async () => {
    const coordinator = new RequestTraceCoordinator();
    coordinator.add(new Promise(() => {}));
    const startedAt = Date.now();
    await coordinator.wait(40);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('graceTicks：微任务迟到登记仍被等待；空集 0 拍立即放行', async () => {
    const coordinator = new RequestTraceCoordinator();
    let done = false;
    const settled = coordinator.wait(2_000, 2);
    registerLateSettle(coordinator, 10, () => {
      done = true;
    });
    await settled;
    expect(done).toBe(true);

    // 非流式路径恒空集传 0：无迟到风险，零延迟放行
    const eager = new RequestTraceCoordinator();
    let eagerDone = false;
    const eagerWait = eager.wait(5_000, 0);
    registerLateSettle(eager, 20, () => {
      eagerDone = true;
    });
    await eagerWait;
    expect(eagerDone).toBe(false);
  });
});

describe('otelTracePort.captureRoot（捕根语义）', () => {
  it('无请求作用域：detached 直跑返回值，不登记等待', async () => {
    const root = otelTracePort.captureRoot();
    expect(await root.runInBackground(async () => 7)).toBe(7);
  });

  it('请求作用域内：后台任务在根上下文运行且计入根生命周期', async () => {
    const coordinator = new RequestTraceCoordinator();
    const rootSpan = getTracer('gateway').startSpan('root.capture');
    const rootContext = trace.setSpan(context.active(), rootSpan);
    await requestTraceStorage.run({ rootContext, coordinator }, async () => {
      void otelTracePort.captureRoot().runInBackground(probeBackgroundSettle);
      await coordinator.wait(2_000, 1);
    });
    rootSpan.end();
    expect(probeActiveSpanId).toBe(rootSpan.spanContext().spanId);
  });
});

describe('otel 中间件：SSE 接力收口（根 span 时窗不变量）', () => {
  it('根 span 在体送完 ∧ 后台收尾完成后才闭合；收尾 span 直挂根', async () => {
    otel.memory?.clear();
    // 时序证据用 onEnd 到达序而非 endTimeMs 大小：OTel hrTime()（timeOrigin +
    // performance.now()）在同毫秒内可回读——实测相邻两次 span end 的时间戳可
    // 倒置 ~20µs，而 processor 收到 onEnd 的调用序与 end() 调用序严格一致。
    const endedOrder: string[] = [];
    const proc = defined(otel.memory, 'otel.memory').processor;
    const origOnEnd = proc.onEnd.bind(proc);
    proc.onEnd = (span) => {
      endedOrder.push(span.name);
      origOnEnd(span);
    };
    const { gate, open } = createGate();
    const res = await gatedSseApp(gate).request('/v1/stream');
    expect(res.status).toBe(200);
    // 响应已返回但体未送完、收尾未完成 → 根 span 未闭合
    expect(endedSpan('GET /v1/stream')).toBeUndefined();

    const text = await res.text();
    expect(text).toContain('data: 1');
    // 体已送完但收尾被门挡住 → 跨过多个等待周期仍未闭合（时窗不逃逸）
    await tick(150);
    expect(endedSpan('GET /v1/stream')).toBeUndefined();

    open();
    await until(() => endedSpan('GET /v1/stream') != null);
    const root = defined(endedSpan('GET /v1/stream'), 'root span');
    const bg = defined(endedSpan('bg.settle'), 'bg.settle span');
    expect(bg.traceId).toBe(root.traceId); // 同一棵树（不孤儿）
    expect(bg.parentSpanId).toBe(root.spanId); // 直挂根 span
    // 收尾 span 先闭合、根 span 后闭合（时窗不变量：子 span 全落根时间窗内）
    expect(endedOrder.indexOf('bg.settle')).toBeLessThan(endedOrder.indexOf('GET /v1/stream'));
  });

  it('客户端取消：流 cancel 后收口根 span，且不置 ERROR（取消非服务错误）', async () => {
    otel.memory?.clear();
    let enqueued = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued < 3) {
          enqueued += 1;
          controller.enqueue(encode(`data: ${enqueued}\n\n`));
        } else {
          controller.close();
        }
      },
    });
    const app = sseApp(
      () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    );

    const res = await app.request('/v1/stream');
    const reader = defined(res.body, 'res.body').getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel('client gone');
    await until(() => endedSpan('GET /v1/stream') != null);
    const root = defined(endedSpan('GET /v1/stream'), 'root span');
    expect(root.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('流错误：错误透传给消费方，根 span 置 ERROR 后收口', async () => {
    otel.memory?.clear();
    let first = true;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(encode('data: 1\n\n'));
          return;
        }
        throw new Error('upstream blew up');
      },
    });
    const app = sseApp(
      () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    );

    const res = await app.request('/v1/stream');
    await expect(res.text()).rejects.toThrow('upstream blew up');
    await until(() => endedSpan('GET /v1/stream') != null);
    const root = defined(endedSpan('GET /v1/stream'), 'root span');
    expect(root.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'upstream blew up' });
  });
});
