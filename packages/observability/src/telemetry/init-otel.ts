import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { observabilityErrors } from '../errors';
import { createMemoryTraceViewer, type MemoryTraceViewer } from './memory-viewer';
import { createLogSpanProcessor, type SpanLogSink } from './log-span-processor';

/**
 * 链路追踪模式:
 *   - off     关闭(生产无观测栈时)
 *   - memory  进程内环形缓冲 + 查看页数据源:零基建,开发默认
 *   - console 每次 span 结束打一行结构化日志(可 grep,适合 CI/无浏览器场景)
 *   - otlp    导出 OTLP collector(生产观测栈)
 */
export type OtelMode = 'off' | 'memory' | 'console' | 'otlp';

export interface InitOtelOptions {
  serviceName: string;
  /** 服务版本(资源属性;铁律 3 必填注入,不藏缺省) */
  serviceVersion: string;
  mode: OtelMode;
  /** OTLP HTTP 端点(collector),如 http://otel-collector:4318;mode=otlp 时必填 */
  endpoint?: string;
  /** mode=console 时的日志出口(必填,不再藏 console 缺省) */
  logger?: SpanLogSink;
  /** mode=otlp 的指标推送周期毫秒(必填注入,不写死) */
  metricsExportIntervalMs?: number;
  /** OTLP 推送鉴权(Bearer)。显式装配传入——与接收端同键同值,缺此值 = span 全部 401 拒收 */
  authToken?: string;
}

export interface OtelHandle {
  mode: OtelMode;
  shutdown(): Promise<void>;
  /** mode=memory 时的查看页数据源(G9:返回句柄,不再模块全局) */
  memory?: MemoryTraceViewer;
}

/**
 * OTel SDK 初始化(应用启动时调用一次)。
 *   - off:完全 no-op(业务代码拿到的 tracer/meter 无开销)
 *   - memory:内存环形缓冲处理器
 *   - console:一行结构化日志处理器
 *   - otlp:BatchSpanProcessor → OTLP collector(traces + metrics,双通道同令牌)
 * otlp 缺 endpoint 启动期 fail-fast(G2:authToken 无 env 回落,装配显式传)。
 */
export function initOtel(options: InitOtelOptions): OtelHandle {
  const { serviceName, serviceVersion, mode, endpoint, logger, metricsExportIntervalMs } = options;
  if (mode === 'off') {
    return { mode, shutdown: async () => {} };
  }
  if (mode === 'otlp' && !endpoint) {
    throw observabilityErrors.business('otel_endpoint_missing', { serviceName });
  }
  // 铁律 3 收口:console 模式的日志出口与 otlp 模式的指标周期必填,不再藏缺省
  if (mode === 'console' && logger == null) {
    throw observabilityErrors.business('otel_option_missing', {
      field: 'logger',
      reason: 'required when mode is console',
    });
  }
  if (mode === 'otlp' && (metricsExportIntervalMs == null || metricsExportIntervalMs <= 0)) {
    throw observabilityErrors.business('otel_option_missing', {
      field: 'metricsExportIntervalMs',
      reason: 'positive integer required when mode is otlp',
    });
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });
  const authHeaders = options.authToken
    ? { headers: { Authorization: `Bearer ${options.authToken}` } }
    : {};

  let memory: MemoryTraceViewer | undefined;
  const spanProcessors =
    mode === 'memory'
      ? ((memory = createMemoryTraceViewer()), [memory.processor])
      : mode === 'console'
        ? [createLogSpanProcessor(logger!)]
        : [
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url: `${endpoint}/v1/traces`,
                ...authHeaders,
              }),
            ),
          ];

  const sdk = new NodeSDK({
    resource,
    spanProcessors,
    ...(mode === 'otlp'
      ? {
          metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: `${endpoint}/v1/metrics`,
              ...authHeaders,
            }),
            exportIntervalMillis: metricsExportIntervalMs!,
          }),
        }
      : {}),
  });

  sdk.start();
  return {
    mode,
    shutdown: () => sdk.shutdown(),
    ...(memory ? { memory } : {}),
  };
}
