/**
 * 装配子入口：外部目录源 adapter——由 app assembly 选择后注入
 * `ControlPlaneEnv.sources`（根入口不导出 adapter）。
 * 引用白名单：仅 apps 装配层（assembly.ts）、迁移脚本与 adapter 集成测试；
 * 包内业务代码（src 下除本文件）禁止 import 本入口（__test__/boundary.test.ts 门禁）。
 */
export { createOpenRouterSource } from './adapters/model-sources/openrouter-source';
export { modelsDevSource } from './adapters/model-sources/models-dev-source';

// ---- postgres store 工厂（热路径读的装配取件面） ----
export { postgresModelStore } from './adapters/postgres/model-store';
export { postgresChannelStore } from './adapters/postgres/channel-store';
export { postgresRateCardStore } from './adapters/postgres/rate-card-store';

// ---- 集成动态配置 reader（消费进程装配取件） ----
import type { Db } from '@tillgate/db';

import type { SecretCipher } from './ports/secret-cipher';
import type { IntegrationSettingsReader } from './application/integrations/create-reader';
import { createIntegrationSettingsReader } from './application/integrations/create-reader';
import { postgresIntegrationSettingsStore } from './adapters/postgres/integration-settings-store';

/** postgres 版 reader：app 装配层只注入 db/cipher（可选 TTL/时钟） */
export function createPostgresIntegrationSettingsReader(args: {
  readonly db: Db;
  readonly cipher: SecretCipher;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** 后台刷新失败钩子（latest 同步面错误出口） */
  readonly onError?: (error: unknown) => void;
}): IntegrationSettingsReader {
  return createIntegrationSettingsReader({
    db: args.db,
    cipher: args.cipher,
    ttlMs: args.ttlMs,
    now: args.now,
    onError: args.onError,
    stores: { integrationSettings: postgresIntegrationSettingsStore },
  });
}
