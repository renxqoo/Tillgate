/**
 * 生成 DTO 门禁（总纲 P6/api-client 侧换轨）：
 *   1. 文件头「GENERATED——禁止手改」标记在位;
 *   2. 入库 dto/admin-api.generated.ts 与「openapi.json → renderAdminApiDto」重生成逐字节相等
 *      （生成物唯一写入方 = bun run generate:dto,产物来源 = admin-api generated/openapi.json
 *      入库交付物——api-client 不 import admin-api 源码,DESIGN §3.4）;
 *   3. 导出集合快照（保名兼容的封闭词表——与换轨前手写版完全一致,消费方零改动）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderAdminApiDto } from '../scripts/generate-dto';

const HERE = dirname(fileURLToPath(import.meta.url));
const DTO_PATH = join(HERE, '..', 'src', 'dto', 'admin-api.generated.ts');
const OPENAPI_ARTIFACT = join(
  HERE,
  '..',
  '..',
  '..',
  'apps',
  'admin-api',
  'generated',
  'openapi.json',
);

/** 导出类型封闭词表（与换轨前手写版逐名相等——增删即消费方破坏性变更） */
const EXPORTED_NAMES: readonly string[] = [
  'AdminBatchRow',
  'AdminChannelFundRow',
  'AdminChannelRow',
  'AdminCreateBody',
  'AdminKeyRow',
  'AdminKeyUpdateBody',
  'AdminMeInfo',
  'AdminModelRow',
  'AdminPatchBody',
  'AdminProviderRow',
  'AdminRateCardRow',
  'AdminRow',
  'AdminSubscriptionRow',
  'AdminTransactionRow',
  'AdminUsageRow',
  'AdminUserRow',
  'AuditLogRow',
  'BatchCreateBody',
  'BatchCreated',
  'ChannelCreateBody',
  'ChannelHealthRow',
  'ChannelOption',
  'ChannelTestResult',
  'ChannelUpdateBody',
  'DeadCaseDecisionBody',
  'DeadCaseRow',
  'LogRow',
  'ModelCreateBody',
  'ModelUpdateBody',
  'PermissionNode',
  'PlanCreateBody',
  'PlanRow',
  'PlanUpdateBody',
  'ProviderCreateBody',
  'ProviderOption',
  'RateCardCreateBody',
  'RateCardOption',
  'RateCardUpdateBody',
  'RedeemCodeRow',
  'RoleRow',
  'StatsOverview',
  'StatsTrendRow',
  'StatsTrends',
  'StatsUsageItem',
  'TraceDetailDto',
  'TraceSpanRow',
  'TraceSummaryRow',
  'TraceTopologyResponse',
  'TracingStatsResponse',
];

describe('生成 DTO（P6 换轨门禁）', () => {
  it('文件头 GENERATED 禁止手改标记在位', () => {
    const head = readFileSync(DTO_PATH, 'utf8').slice(0, 200);
    expect(head).toContain('GENERATED');
    expect(head).toContain('禁止手改');
  });

  it('入库文件与 openapi.json 重生成逐字节相等（generate:dto 是唯一写入方）', () => {
    const openapi = JSON.parse(readFileSync(OPENAPI_ARTIFACT, 'utf8'));
    expect(readFileSync(DTO_PATH, 'utf8')).toBe(renderAdminApiDto(openapi));
  });

  it('导出集合与快照逐名相等（保名兼容封闭词表）', () => {
    const names = [
      ...readFileSync(DTO_PATH, 'utf8').matchAll(/export (?:interface|type) (\w+)/g),
    ].map((m) => m[1]!);
    expect(names.toSorted()).toEqual([...EXPORTED_NAMES]);
  });
});
