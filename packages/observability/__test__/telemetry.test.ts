import { describe, expect, it } from 'vitest';
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { observabilityErrors } from '../src/errors';
import { initOtel } from '../src/telemetry/init-otel';
import { createMemoryTraceViewer } from '../src/telemetry/memory-viewer';
import { createLogSpanProcessor, type SpanLogSink } from '../src/telemetry/log-span-processor';
import { formatTraceParent, remoteParentContext } from '../src/telemetry/trace-parent';
import { withAsyncSpan } from '../src/telemetry/with-span';
import { getMeter, getTracer } from '../src/telemetry/api';

/**
 * telemetry 规格(v1 core/otel.ts 零测试,B2 补齐——铁律 16)。
 * 收集器用本包 MemoryTraceViewer(真实 SDK 管线,不 mock 处理器契约)。
 * traceId 生成注意:hex 前缀 + '0' 右补会在 '1'/'10' 间碰撞——补位用非零字符。
 */

/** 伪造最小 ReadableSpan(snapshot 只读这些字段);startOffsetMs 相对基点,时长恒 150ms */
function fakeEndSpan(
  traceId: string,
  spanId: string,
  startOffsetMs = 0,
  name = 'op',
): ReadableSpan {
  return {
    name,
    spanContext: () => ({ traceId, spanId, traceFlags: 1, isRemote: false }),
    parentSpanContext: undefined,
    startTime: [1_700_000_000, startOffsetMs * 1_000_000],
    endTime: [1_700_000_000, (startOffsetMs + 150) * 1_000_000],
    attributes: {},
    status: { code: SpanStatusCode.UNSET },
    events: [],
    resource: { attributes: { 'service.name': 'test-svc' } },
  } as unknown as ReadableSpan;
}

/** 注入式 traceId(0..n 互异,补位 'f' 防前缀碰撞) */
function traceIdOf(i: number): string {
  return `${(0x1000 + i).toString(16)}${'f'.repeat(28)}`;
}

describe('initOtel', () => {
  it('mode=off 完全 no-op:无 memory 句柄,shutdown 即解', async () => {
    const handle = initOtel({ serviceName: 'svc', serviceVersion: '0.1.0', mode: 'off' });
    expect(handle.mode).toBe('off');
    expect(handle.memory).toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('mode=otlp 缺 endpoint 启动期 fail-fast(目录码)', () => {
    try {
      initOtel({ serviceName: 'svc', serviceVersion: '0.1.0', mode: 'otlp' });
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('observability.otel_endpoint_missing');
      expect(observabilityErrors.has('observability.otel_endpoint_missing')).toBe(true);
    }
  });

  it('铁律 3 收口:console 缺 logger / otlp 缺指标周期 fail-fast(otel_option_missing)', () => {
    try {
      initOtel({ serviceName: 'svc', serviceVersion: '0.1.0', mode: 'console' });
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('observability.otel_option_missing');
    }
    try {
      initOtel({
        serviceName: 'svc',
        serviceVersion: '0.1.0',
        mode: 'otlp',
        endpoint: 'http://127.0.0.1:14318',
        metricsExportIntervalMs: 0,
      });
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('observability.otel_option_missing');
    }
  });

  it('mode=memory 返回查看句柄且 SDK 可启停(处理器即 viewer 的采集面)', async () => {
    const handle = initOtel({ serviceName: 'svc', serviceVersion: '0.1.0', mode: 'memory' });
    expect(handle.mode).toBe('memory');
    expect(handle.memory).toBeDefined();
    handle.memory!.processor.onEnd(fakeEndSpan('f'.repeat(32), '01', 0, 'mem-op'));
    expect(handle.memory!.recent()).toHaveLength(1);
    expect(handle.memory!.recent()[0]!.rootName).toBe('mem-op');
    await handle.shutdown();
    expect(handle.memory!.recent()).toHaveLength(0); // shutdown 清缓冲
  });

  it('mode=console 可启停(构造 console 处理器分支)', async () => {
    const handle = initOtel({
      serviceName: 'svc',
      serviceVersion: '0.1.0',
      mode: 'console',
      logger: { info() {}, warn() {} },
    });
    expect(handle.mode).toBe('console');
    expect(handle.memory).toBeUndefined();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('mode=otlp 带端点可启停(导出器构造,空队列 shutdown 不触网)', async () => {
    const handle = initOtel({
      serviceName: 'svc',
      serviceVersion: '0.1.0',
      mode: 'otlp',
      endpoint: 'http://127.0.0.1:14318',
      authToken: 't0k3n',
      metricsExportIntervalMs: 10_000,
    });
    expect(handle.mode).toBe('otlp');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

describe('createMemoryTraceViewer', () => {
  it('span 处理器全生命周期钩子无害:onStart/forceFlush/shutdown 均可调用', async () => {
    const viewer = createMemoryTraceViewer();
    viewer.processor.onStart({} as never, undefined as never); // 只在 onEnd 快照,onStart 无操作
    await viewer.processor.forceFlush();
    viewer.processor.onEnd(fakeEndSpan('a'.repeat(32), '01', 0, 'lifecycle'));
    await viewer.processor.shutdown();
    expect(viewer.recent()).toHaveLength(0);
  });

  it('span 结束入缓冲;recent 按根开始时间倒序、limit 截断;clear 清空', () => {
    const viewer = createMemoryTraceViewer();
    viewer.processor.onEnd(fakeEndSpan('a'.repeat(32), '01', 0, 'first'));
    viewer.processor.onEnd(fakeEndSpan('b'.repeat(32), '02', 1_000, 'second'));
    viewer.processor.onEnd(fakeEndSpan('c'.repeat(32), '03', 2_000, 'third'));
    const recent = viewer.recent(2);
    expect(recent.map((t) => t.rootName)).toEqual(['third', 'second']); // 倒序 + limit
    expect(recent[0]!.spanCount).toBe(1);
    expect(recent[0]!.services).toEqual(['test-svc']);
    viewer.clear();
    expect(viewer.recent()).toHaveLength(0);
  });

  it('同 trace 多 span 聚合:根推断、总时长、span 时间序,与到达序无关', () => {
    const viewer = createMemoryTraceViewer();
    const traceId = 'a'.repeat(32);
    // 先结束子(父=root,晚 500ms)再结束根——聚合不依赖到达序
    viewer.processor.onEnd({
      ...fakeEndSpan(traceId, '02', 500, 'child'),
      parentSpanContext: { traceId, spanId: '01', traceFlags: 1, isRemote: false },
    } as unknown as ReadableSpan);
    viewer.processor.onEnd(fakeEndSpan(traceId, '01', 0, 'root'));
    const [trace] = viewer.recent();
    expect(trace!.rootName).toBe('root');
    expect(trace!.spanCount).toBe(2);
    expect(trace!.durationMs).toBeGreaterThanOrEqual(650); // child 终点 = 500+150
    expect(trace!.spans.map((s) => s.name)).toEqual(['root', 'child']); // 按 startTime 升序
  });

  it('错误 span 置 hasError(status.code=ERROR)', () => {
    const viewer = createMemoryTraceViewer();
    const bad = {
      ...fakeEndSpan('a'.repeat(32), '01', 0, 'bad'),
      status: { code: SpanStatusCode.ERROR, message: 'boom' },
    } as unknown as ReadableSpan;
    viewer.processor.onEnd(bad);
    expect(viewer.recent()[0]!.hasError).toBe(true);
  });

  it('MAX_TRACES 淘汰:第 201 条 trace 顶掉最旧(200 上界)', () => {
    const viewer = createMemoryTraceViewer();
    for (let i = 0; i < 201; i++) {
      viewer.processor.onEnd(
        fakeEndSpan(traceIdOf(i), `${(0x1000 + i).toString(16)}${'e'.repeat(12)}`),
      );
    }
    expect(viewer.recent(500)).toHaveLength(200);
    // 最旧(traceIdOf(0))被淘汰:全部 recent 的 traceId 不含它
    expect(viewer.recent(500).some((t) => t.traceId === traceIdOf(0))).toBe(false);
    expect(viewer.recent(500).some((t) => t.traceId === traceIdOf(200))).toBe(true);
  });

  it('MAX_SPANS_TOTAL 淘汰:总 span 超 4000 按最旧 trace 整组淘汰', () => {
    const viewer = createMemoryTraceViewer();
    // 3 trace × 1600 span = 4800 > 4000 → 最旧的 trace 整组被淘汰
    let seq = 0;
    for (let t = 0; t < 3; t++) {
      for (let s = 0; s < 1600; s++) {
        seq += 1;
        viewer.processor.onEnd(
          fakeEndSpan(traceIdOf(t), `${(0x1000 + seq).toString(16)}${'e'.repeat(12)}`),
        );
      }
    }
    const recent = viewer.recent(10);
    expect(recent).toHaveLength(2); // 第一组被整组淘汰
    expect(recent.every((t) => t.spanCount === 1600)).toBe(true);
    expect(recent.some((t) => t.traceId === traceIdOf(0))).toBe(false);
  });
});

describe('createLogSpanProcessor', () => {
  it('span 结束一行结构化日志:正常 info、ERROR 升 warn 带错误消息', async () => {
    const lines: Array<{ level: string; line: Record<string, unknown> }> = [];
    const logger: SpanLogSink = {
      info: (obj) => lines.push({ level: 'info', line: obj as Record<string, unknown> }),
      warn: (obj) => lines.push({ level: 'warn', line: obj as Record<string, unknown> }),
    };
    const processor: SpanProcessor = createLogSpanProcessor(logger);
    processor.onStart({} as never, undefined as never);
    await processor.forceFlush();
    processor.onEnd(fakeEndSpan('a'.repeat(32), '01', 0, 'ok-span'));
    processor.onEnd({
      ...fakeEndSpan('a'.repeat(32), '02', 0, 'bad-span'),
      status: { code: SpanStatusCode.ERROR, message: 'timeout' },
    } as unknown as ReadableSpan);
    await processor.shutdown();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.level).toBe('info');
    expect(lines[0]!.line['span']).toBe('ok-span');
    expect(lines[0]!.line['durationMs']).toBe(150);
    expect(lines[0]!.line['attrs']).toBeUndefined(); // 无属性不带 attrs 键
    expect(lines[1]!.level).toBe('warn');
    expect(lines[1]!.line['error']).toBe('timeout');
    expect(lines[1]!.line['traceId']).toBe('a'.repeat(32));
  });
});

describe('traceparent', () => {
  it('formatTraceParent:合法上下文出 00-…-01;无效(全零)出 null', () => {
    const valid = {
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 1,
      isRemote: false,
    };
    expect(formatTraceParent(valid)).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    const invalid = {
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 1,
      isRemote: false,
    };
    expect(formatTraceParent(invalid)).toBeNull();
  });

  it('remoteParentContext:合法解析为远端父;非法形状拒绝', () => {
    const ok = remoteParentContext(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(ok).toBeDefined();
    expect(remoteParentContext(undefined)).toBeUndefined();
    expect(remoteParentContext(null)).toBeUndefined();
    expect(remoteParentContext('not-a-traceparent')).toBeUndefined();
    expect(remoteParentContext(`ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`)).toBeUndefined();
    expect(remoteParentContext(`00-${'a'.repeat(31)}-${'b'.repeat(16)}-01`)).toBeUndefined();
    expect(remoteParentContext(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-02`)).toBeUndefined();
  });
});

/** 真实 SDK 管线收集器:tracer 产的 span 经处理器入 viewer 缓冲 */
function collectTracer(): { viewer: ReturnType<typeof createMemoryTraceViewer>; tracer: Tracer } {
  const viewer = createMemoryTraceViewer();
  // OTel v2:处理器经构造参数注入(实例方法 addSpanProcessor 已移除)
  const provider = new BasicTracerProvider({ spanProcessors: [viewer.processor] });
  return { viewer, tracer: provider.getTracer('test') };
}

describe('withAsyncSpan', () => {
  it('成功路径:span 记属性、正常终态、返回业务值', async () => {
    const { viewer, tracer } = collectTracer();
    const out = await withAsyncSpan(
      tracer,
      'stage.do',
      { 'channel.key': 'ch-a', attempt: 1 },
      async () => 42,
    );
    expect(out).toBe(42);
    const [span] = viewer.recent()[0]!.spans;
    expect(span!.name).toBe('stage.do');
    expect(span!.attributes['channel.key']).toBe('ch-a');
    expect(span!.status.code).toBe(SpanStatusCode.UNSET); // 未显式设状态(与 v1 行为一致)
    expect(span!.endTimeMs).toBeGreaterThan(span!.startTimeMs);
  });

  it('异常路径:span 记 ERROR + recordException,错误原样上抛(观测不吞错)', async () => {
    const { viewer, tracer } = collectTracer();
    await expect(
      withAsyncSpan(tracer, 'stage.fail', {}, async () => {
        throw new Error('upstream 502');
      }),
    ).rejects.toThrow('upstream 502');
    const [span] = viewer.recent()[0]!.spans;
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('upstream 502');
    expect(span!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('非 Error 抛出物:message 走 String 归一,仍记 ERROR', async () => {
    const { viewer, tracer } = collectTracer();
    await expect(
      withAsyncSpan(tracer, 'stage.raw', {}, async () => {
        throw 'raw-string'; // eslint-disable-line no-throw-literal
      }),
    ).rejects.toBe('raw-string');
    const [span] = viewer.recent()[0]!.spans;
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('raw-string');
    expect(span!.events).toHaveLength(0); // recordException 只收 Error 实例
  });

  it('getTracer/getMeter 未启动 SDK 时返回全局 no-op 形态(零开销)', () => {
    expect(() => getTracer('any')).not.toThrow();
    expect(() => getMeter('any')).not.toThrow();
  });
});
