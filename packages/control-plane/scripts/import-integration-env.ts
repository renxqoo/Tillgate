/**
 * 第三方集成凭据一次性导入：env → integration_settings
 * （docs/integration-settings/DESIGN.md §7.2；本脚本 = env 时代的退出路径）。
 *
 * 运行：bun --env-file=.env packages/control-plane/scripts/import-integration-env.ts
 * （等价根任务 `bun run integrations:import`）
 *
 * 语义：
 * - 完整组（必填全在场）→ insert-if-absent 落行并 enabled=true
 *   （幂等：已有键跳过，不覆盖 admin 已改值）；
 * - 非空不完整组 → 跳过并警告（对齐存量启动 assertGroup 口径，不部分导入）；
 * - 全空组 → 未配置（不落行）。
 * 前置：DATABASE_URL、ENCRYPTION_KEY（与 admin-api 加密同根键——DESIGN §5 D3 部署契约；
 * 仅脚本需要 runtime 加密器，src 层禁依赖 runtime 的边界不变）。
 */
import { closeDb, createDb } from '@tillgate/db';
import { createCipher } from '@tillgate/runtime';

import { createPostgresAuditSink } from '../src/adapters/postgres/audit';
import { postgresIntegrationSettingsStore } from '../src/adapters/postgres/integration-settings-store';
import {
  applyIntegrationImport,
  planIntegrationImport,
} from '../src/application/integrations/import-from-env';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value.length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

// 一次性脚本：保守小池（不与服务进程抢连接额度）
const db = createDb({
  url: requiredEnv('DATABASE_URL'),
  poolMax: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
const cipher = createCipher(requiredEnv('ENCRYPTION_KEY'));

const plan = planIntegrationImport(process.env);
console.log(
  `[integrations:import] plan: ${plan.imports.length} importable, ${plan.skipped.length} incomplete-skipped, ${plan.absent.length} absent`,
);
for (const skip of plan.skipped) {
  console.warn(
    `[integrations:import] SKIP ${skip.key}: missing [${skip.missing.join(', ')}], present [${skip.present.join(', ')}]`,
  );
}

const report = await applyIntegrationImport(
  {
    db,
    stores: { integrationSettings: postgresIntegrationSettingsStore },
    cipher,
    audit: createPostgresAuditSink(db),
    now: () => new Date(),
  },
  plan,
);
for (const key of report.imported)
  console.log(`[integrations:import] imported ${key} (enabled=true)`);
for (const key of report.skippedExisting)
  console.log(`[integrations:import] exists, kept as-is: ${key}`);

await closeDb(db);
