/**
 * observability 错误目录(能力包自有目录,码带命名空间)。
 * 身份码 = `observability.<key>`;message 英文、zh 中文。
 * 码表封闭性由 __test__/architecture.test.ts 快照锁死;新增码 = 契约变更。
 */
import { defineErrorCatalog } from '@tillgate/errors';

export const observabilityErrors = defineErrorCatalog('observability', {
  /** OTLP 结构级错误(非对象/缺 resourceSpans)——接收端映射 400 */
  invalid_otlp_payload: {
    category: 'invalid_input',
    message: 'OTLP payload is structurally invalid',
    zh: 'OTLP 载荷结构非法(须为含 resourceSpans 数组的 JSON 对象)',
  },
  /** mode=otlp 未配 collector 端点——启动期 fail-fast,不进运行时 */
  otel_option_missing: {
    message: 'observability otel option missing or invalid',
    zh: 'OTel 装配参数缺失或不合法(console 模式需 logger;otlp 模式需正的 metricsExportIntervalMs)',
    category: 'invalid_input',
  },
  otel_endpoint_missing: {
    category: 'invalid_input',
    message: 'OTLP endpoint must be configured when mode is otlp',
    zh: '追踪模式为 otlp 时必须配置导出端点(collector)',
  },
  /** 分区日期非 UTC 'YYYY-MM-DD'——内部调用方缺陷防御 */
  invalid_partition_day: {
    category: 'invalid_input',
    message: 'Invalid partition day',
    zh: '分区日期非法(须为 YYYY-MM-DD)',
  },
});
