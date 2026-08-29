import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTING_FORM_BOUNDS } from '../src/features/routing/routing-bounds';

/**
 * 表单边界镜像 vs wire 契约对照（漂移门禁）。
 * 链路：@tillgate/inference routingPolicySchema（单一真相）→ admin-api openapi
 * registry → generated/openapi.json（入库交付物，openapi.test 锁重生成逐字节
 * 相等）→ 本测试。schema 改边界而 ROUTING_FORM_BOUNDS 未跟（或反之）即红。
 * admin 不依赖能力包（零能力包直依赖定位），故经交付物对照而非直接 import schema
 * ——与 api-client 消费 openapi.json 的既有模式一致（不 import admin-api 源码）。
 */
const OPENAPI_ARTIFACT = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'admin-api',
  'generated',
  'openapi.json',
);

/** openapi 组件里的 JSON Schema 数值节点（生成器只消费这些键） */
interface WireNumberSchema {
  type?: string;
  minimum?: number;
  maximum?: number;
}

/** bounds 键 → openapi.json 内 RoutingPolicySaveBody 组件的属性路径（schema 段展开） */
const WIRE_PATHS: Readonly<Record<keyof typeof ROUTING_FORM_BOUNDS, string[]>> = {
  cacheBoost: ['policy', 'scorers', 'cacheAffinity', 'boost'],
  softRatio: ['policy', 'scorers', 'budgetWatermark', 'softRatio'],
  sameChannelMaxRetries: ['policy', 'retry', 'sameChannelMaxRetries'],
  rateLimitBaseMs: ['policy', 'penalty', 'rateLimitBaseMs'],
  rateLimitMaxMs: ['policy', 'penalty', 'rateLimitMaxMs'],
  quotaMs: ['policy', 'penalty', 'quotaMs'],
  modelDeadThreshold: ['policy', 'modelDead', 'failureThreshold'],
  maxWaitMs: ['policy', 'wait', 'maxWaitMs'],
};

function wireNode(paths: readonly string[]): WireNumberSchema {
  const doc = JSON.parse(readFileSync(OPENAPI_ARTIFACT, 'utf8')) as {
    components: { schemas: Record<string, unknown> };
  };
  const body = doc.components.schemas['RoutingPolicySaveBody'] as unknown;
  let node: unknown = body;
  for (const segment of paths) {
    const { properties } = node as { properties?: Record<string, unknown> };
    expect(properties, `wire path ${paths.join('.')} 的父节点缺 properties`).toBeDefined();
    node = properties?.[segment];
    expect(node, `wire path ${paths.join('.')} 的 ${segment} 段缺失`).toBeDefined();
  }
  return node as WireNumberSchema;
}

describe('ROUTING_FORM_BOUNDS ↔ openapi 契约对照', () => {
  it('逐字段边界（min/max/integer）与 wire schema 完全一致', () => {
    for (const [key, path] of Object.entries(WIRE_PATHS) as Array<
      [keyof typeof ROUTING_FORM_BOUNDS, string[]]
    >) {
      const bound = ROUTING_FORM_BOUNDS[key];
      const wire = wireNode(path);
      expect(wire.minimum, `${key} min 漂移（schema 改了？同步 routing-bounds.ts）`).toBe(
        bound.min,
      );
      expect(wire.maximum, `${key} max 漂移`).toBe(bound.max);
      expect(wire.type === 'integer', `${key} 整数性漂移`).toBe(bound.integer);
    }
  });

  it('bounds 覆盖全部 8 个数值表单字段（增删字段必须同步本对照）', () => {
    expect(Object.keys(ROUTING_FORM_BOUNDS).toSorted()).toEqual([
      'cacheBoost',
      'maxWaitMs',
      'modelDeadThreshold',
      'quotaMs',
      'rateLimitBaseMs',
      'rateLimitMaxMs',
      'sameChannelMaxRetries',
      'softRatio',
    ]);
  });
});
