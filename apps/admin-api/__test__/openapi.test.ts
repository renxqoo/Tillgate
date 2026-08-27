/**
 * OpenAPI 生成链门禁（admin-api 侧）：
 *   1. 入库产物与内存重生成逐字节相等——禁止手改（generator 是唯一写入方）;
 *   2. 端点词表封闭：method+path 全集快照（增删端点 = registry 变更 → 必须同步本表
 *      并重生成产物,一处不落即红）;
 *   3. 文档基本面：OpenAPI 3.1 + servers + 全端点有 tag/summary。
 * 生成命令：bun run generate:openapi（详见 scripts/generate-openapi.ts 头注释）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAdminOpenApiDocument } from '../src/http/openapi/index';

const ARTIFACT = join(dirname(fileURLToPath(import.meta.url)), '..', 'generated', 'openapi.json');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** 端点全集（封闭词表快照——与 registry 一一对应,来自 generated/openapi.json） */
const ENDPOINTS: readonly string[] = [
  'DELETE /v1/channels/:id',
  'DELETE /v1/endpoint-bindings/:id',
  'DELETE /v1/fx/catalog/override',
  'DELETE /v1/models/:id',
  'DELETE /v1/notifications/:id',
  'DELETE /v1/permissions/:id',
  'DELETE /v1/plans/:id',
  'DELETE /v1/providers/:id',
  'DELETE /v1/rate-cards/:id',
  'DELETE /v1/roles/:id',
  'GET /v1/admin-keys',
  'GET /v1/admins',
  'GET /v1/analytics/channel-ttft',
  'GET /v1/audit-logs',
  'GET /v1/billing-operations',
  'GET /v1/channel-funds',
  'GET /v1/channels',
  'GET /v1/endpoint-bindings',
  'GET /v1/fx/catalog',
  'GET /v1/generation-tasks',
  'GET /v1/logs',
  'GET /v1/marketing/settings',
  'GET /v1/me',
  'GET /v1/me/menus',
  'GET /v1/model-catalog/:sourceId',
  'GET /v1/model-catalog/price-history',
  'GET /v1/model-catalog/sources',
  'GET /v1/models',
  'GET /v1/notifications',
  'GET /v1/payment-orders',
  'GET /v1/permissions/tree',
  'GET /v1/plans',
  'GET /v1/providers',
  'GET /v1/rate-cards',
  'GET /v1/rate-cards/:id/health',
  'GET /v1/rate-cards/:id/users',
  'GET /v1/redeem-batches',
  'GET /v1/redeem-batches/:id',
  'GET /v1/redeem-batches/:id/codes',
  'GET /v1/referrals/payouts',
  'GET /v1/referrals/relations',
  'GET /v1/roles',
  'GET /v1/settings/billing-timezone',
  'GET /v1/settings/integrations',
  'GET /v1/stats/overview',
  'GET /v1/stats/trends',
  'GET /v1/stats/usage',
  'GET /v1/subscriptions',
  'GET /v1/tracing/by-request/:requestId',
  'GET /v1/tracing/recent',
  'GET /v1/tracing/stats',
  'GET /v1/tracing/topology',
  'GET /v1/tracing/traces/:traceId',
  'GET /v1/usage-logs',
  'GET /v1/users',
  'GET /v1/users/:id',
  'GET /v1/users/:id/audit-logs',
  'GET /v1/users/:id/transactions',
  'GET /v1/vendor-catalog',
  'GET /v1/vouchers/:key',
  'PATCH /v1/admin-keys/:id',
  'PATCH /v1/admins/:id',
  'PATCH /v1/channels/:id',
  'PATCH /v1/endpoint-bindings/:id',
  'PATCH /v1/models/:id',
  'PATCH /v1/notifications/:id',
  'PATCH /v1/permissions/:id',
  'PATCH /v1/plans/:id',
  'PATCH /v1/providers/:id',
  'PATCH /v1/rate-cards/:id',
  'PATCH /v1/referrals/relations/:id',
  'PATCH /v1/roles/:id',
  'PATCH /v1/users/:id',
  'POST /v1/admins',
  'POST /v1/admins/:id/resend-invite',
  'POST /v1/auth/login',
  'POST /v1/auth/login/totp',
  'POST /v1/auth/login/verify',
  'POST /v1/auth/logout',
  'POST /v1/auth/reset-password',
  'POST /v1/billing-operations/:requestId/abandon',
  'POST /v1/billing-operations/:requestId/retry',
  'POST /v1/channel-funds/adjust',
  'POST /v1/channel-funds/recharge',
  'POST /v1/channels',
  'POST /v1/channels/:id/restore',
  'POST /v1/channels/:id/test',
  'POST /v1/channels/import',
  'POST /v1/endpoint-bindings',
  'POST /v1/fx/catalog/refresh',
  'POST /v1/me/password',
  'POST /v1/me/totp/confirm',
  'POST /v1/me/totp/disable',
  'POST /v1/me/totp/enroll',
  'POST /v1/me/two-factor',
  'POST /v1/me/two-factor/code',
  'POST /v1/model-catalog/import',
  'POST /v1/models',
  'POST /v1/models/:id/channels',
  'POST /v1/models/:id/restore',
  'POST /v1/models/:id/test',
  'POST /v1/notifications',
  'POST /v1/notifications/:id/test',
  'POST /v1/payment-orders/:id/close',
  'POST /v1/permissions',
  'POST /v1/plans',
  'POST /v1/providers',
  'POST /v1/providers/:id/restore',
  'POST /v1/rate-cards',
  'POST /v1/redeem-batches',
  'POST /v1/redeem-batches/codes/:codeId/revoke',
  'POST /v1/roles',
  'POST /v1/settings/integrations/smtp/test',
  'POST /v1/subscriptions/:id/cancel',
  'POST /v1/subscriptions/:id/change',
  'POST /v1/subscriptions/:id/grant',
  'POST /v1/subscriptions/:id/renew',
  'POST /v1/users/:id/adjust',
  'POST /v1/users/:id/gift',
  'POST /v1/users/:id/set-password',
  'PUT /v1/fx/catalog/buffer',
  'PUT /v1/fx/catalog/override',
  'PUT /v1/marketing/settings',
  'PUT /v1/settings/billing-timezone',
  'PUT /v1/settings/integrations/:key',
];

// 模块级:从 OpenAPI 文档收端点清单(提出 describe/it 回调,避免回调深层嵌套)
function endpointListOf(paths: Record<string, Record<string, unknown>>): string[] {
  return Object.entries(paths)
    .flatMap(([path, ops]) =>
      Object.keys(ops)
        .filter((m) => METHODS.has(m))
        .map((m) => `${m.toUpperCase()} ${path}`),
    )
    .toSorted();
}

describe('OpenAPI 生成链（P3）', () => {
  it('入库产物与重生成逐字节相等（禁止手改——generator 是唯一写入方）', () => {
    const regenerated = `${JSON.stringify(buildAdminOpenApiDocument(), null, 2)}\n`;
    expect(readFileSync(ARTIFACT, 'utf8')).toBe(regenerated);
  });

  it('端点词表封闭：method+path 全集与快照逐项相等', () => {
    const doc = buildAdminOpenApiDocument();
    const live = endpointListOf(doc.paths as Record<string, Record<string, unknown>>);
    expect(live).toEqual([...ENDPOINTS]);
  });

  it('文档基本面：OpenAPI 3.1 + 全端点有 tag 与 summary', () => {
    const doc = buildAdminOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    for (const ops of Object.values(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!METHODS.has(method)) continue;
        expect(op.tags?.length, `${method} ${op.summary}`).toBeGreaterThan(0);
        expect(op.summary, `${method} 端点缺 summary`).toBeTruthy();
      }
    }
  });
});
