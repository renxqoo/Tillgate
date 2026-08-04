import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface InitOtelOptions {
  serviceName: string;
  serviceVersion?: string;
  /** OTLP HTTP 端点（collector），如 http://otel-collector:4318/v1/traces */
  endpoint?: string;
  enabled?: boolean;
}

/**
 * OTel SDK 初始化（应用启动时调用一次）。
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

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  });

  sdk.start();
  return {
    shutdown: () => sdk.shutdown(),
  };
}
