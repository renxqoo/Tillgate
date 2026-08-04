import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, metrics, type Tracer, type Span, type Meter, SpanStatusCode } from '@opentelemetry/api';

// Re-export OTel API（SDK 未启动时返回 no-op，业务代码无条件可用）
export { trace, metrics, type Tracer, type Span, type Meter, SpanStatusCode };

export interface InitOtelOptions {
  serviceName: string;
  serviceVersion?: string;
  /** OTLP HTTP 端点（collector），如 http://otel-collector:4318 */
  endpoint?: string;
  enabled?: boolean;
}

/**
 * OTel SDK 初始化（应用启动时调用一次）。
 * 同时配置 traces + metrics 导出（OTLP HTTP）。
 * 采样策略（10% + 错误 100%）在 collector 侧配置，本处全量导出。
 */
export function initOtel({
  serviceName,
  serviceVersion = '0.1.0',
  endpoint,
  enabled = false,
}: InitOtelOptions) {
  if (!enabled) {
    return { shutdown: async () => {} };
  }
  if (!endpoint) {
    throw new Error('OTEL_ENABLED=true 时必须配置 OTEL_EXPORTER_OTLP_ENDPOINT');
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
  });

  sdk.start();
  return {
    shutdown: () => sdk.shutdown(),
  };
}

/** 获取 tracer（SDK 未启动时返回全局 no-op tracer） */
export function getTracer(name = 'ai-gateway'): Tracer {
  return trace.getTracer(name);
}

/** 获取 meter（SDK 未启动时返回全局 no-op meter） */
export function getMeter(name = 'ai-gateway'): Meter {
  return metrics.getMeter(name);
}
